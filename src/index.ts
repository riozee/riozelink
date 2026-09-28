#!/usr/bin/env bun
/**
 * The command line. `riozelink` starts the daemon, `riozelink relay` runs a relay of your own,
 * and the other commands edit the config file without a daemon running, which is what a setup
 * script or a curious user wants.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath, loadConfig, saveConfig, uniqueShareId } from './config.ts';
import { Dashboard } from './dashboard.ts';
import { HOST_VERSION, RiozeLinkHost } from './host.ts';
import { createRelayServer, DEFAULT_RELAY_PORT } from './relay-server.ts';
import { displayPath, maskKey, truncate } from './util.ts';

interface ParsedArgs {
	command: string;
	flags: Map<string, string | boolean>;
	rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
	const flags = new Map<string, string | boolean>();
	const rest: string[] = [];
	let command = 'serve';
	let seenCommand = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg.startsWith('--')) {
			const [name, inline] = arg.slice(2).split('=');
			if (inline !== undefined) {
				flags.set(name, inline);
			} else if (argv[index + 1] && !argv[index + 1].startsWith('-')) {
				flags.set(name, argv[index + 1]);
				index += 1;
			} else {
				flags.set(name, true);
			}
			continue;
		}
		if (arg.startsWith('-') && arg.length > 1) {
			flags.set(arg.slice(1), true);
			continue;
		}
		if (!seenCommand) {
			command = arg;
			seenCommand = true;
			continue;
		}
		rest.push(arg);
	}
	return { command, flags, rest };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
	const value = args.flags.get(name);
	return typeof value === 'string' ? value : undefined;
}

function flagNumber(args: ParsedArgs, name: string): number | undefined {
	const value = flagString(args, name);
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
		throw new Error(`--${name} must be a port number`);
	}
	return parsed;
}

function printHelp(): void {
	process.stdout.write(`riozelink ${HOST_VERSION}

Usage
  riozelink [serve]                 start the daemon (default command)
  riozelink relay                   run a relay of your own
  riozelink folders list            show the shared folders
  riozelink folders add <path> [--label Notes]
  riozelink folders remove <id>
  riozelink clients list            show the browsers this daemon remembers
  riozelink clients revoke <name>   forget one of them
  riozelink status                  a summary of the config file
  riozelink --help                  this text
  riozelink --version

Serve options
  --relay <url>                     the meeting point (default wss://relay.rioze.dev)
  --config-dir <path>               where config.json and identity.json live
  --stun <url>[,<url>]              STUN servers for the WebRTC candidates
  --quiet                           print the words once, then only log lines

Relay options
  --port <n>                        the port to listen on (default ${DEFAULT_RELAY_PORT})
  --bind <address>                  the interface to listen on (default 0.0.0.0)

The daemon never listens on a port. It dials out to a relay and parks a room there, so a
browser anywhere can meet it. The pairing phrase on the panel is four words; it is replaced
every fifteen minutes, or the moment a browser pairs. Nothing about the link is stored in
riozeOS except the browser's own key pair.
`);
}

async function serve(args: ParsedArgs): Promise<void> {
	const quiet = args.flags.get('quiet') === true;
	const configDir = flagString(args, 'config-dir');
	const relay = flagString(args, 'relay');
	const stun = flagString(args, 'stun')
		?.split(',')
		.map((url) => url.trim())
		.filter(Boolean);
	const host = await RiozeLinkHost.create({
		configDir,
		relay,
		iceServers: stun
	});
	await host.start();

	if (quiet) {
		process.stdout.write(`relay ${host.relayUrl()}\nwords ${host.currentPairingPhrase()}\n`);
	}

	const dashboard = quiet
		? null
		: new Dashboard(host, {
				onQuit: () => void shutdown('stopped from the panel')
			});
	dashboard?.start();

	let stopping = false;
	async function shutdown(reason: string): Promise<void> {
		if (stopping) return;
		stopping = true;
		dashboard?.stop();
		await host.stop(reason);
		process.exit(0);
	}

	process.on('SIGINT', () => void shutdown('stopped'));
	process.on('SIGTERM', () => void shutdown('stopped'));

	if (quiet) {
		// Stay alive without a panel; the process is the service.
		await new Promise(() => undefined);
	}
}

async function relay(args: ParsedArgs): Promise<void> {
	const port = flagNumber(args, 'port') ?? DEFAULT_RELAY_PORT;
	const bind = flagString(args, 'bind') ?? '0.0.0.0';
	const server = await createRelayServer({
		port,
		host: bind,
		log: (level, message) => process.stderr.write(`${level}: ${message}\n`)
	});
	process.stdout.write(
		`relay listening on ${bind}:${server.port}\n` +
			`point a daemon at it with: riozelink --relay ws://<host>:${server.port}\n` +
			`and a browser at wss:// on the same address (https pages need wss; http can use ws)\n`
	);

	let stopping = false;
	const shutdown = (): void => {
		if (stopping) return;
		stopping = true;
		void server.close().then(() => process.exit(0));
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	await new Promise(() => undefined);
}

async function folders(args: ParsedArgs): Promise<void> {
	const file = configFilePath();
	const config = await loadConfig(file);
	const action = args.rest[0] ?? 'list';

	if (action === 'list') {
		const entries = Object.entries(config.folders);
		if (entries.length === 0) {
			process.stdout.write('No folders are shared yet. `riozelink folders add <path>`.\n');
			return;
		}
		for (const [id, share] of entries) {
			process.stdout.write(`${id}\t${share.label}\t${displayPath(share.path)}\n`);
		}
		return;
	}

	if (action === 'add') {
		const target = args.rest[1];
		if (!target) throw new Error('folders add needs a path');
		const resolved = path.resolve(target);
		const info = await stat(resolved).catch(() => null);
		if (!info?.isDirectory()) throw new Error(`${resolved} is not a folder`);
		const label = flagString(args, 'label') ?? path.basename(resolved);
		const id = uniqueShareId(config, label);
		config.folders[id] = { label: truncate(label, 64), path: resolved };
		await saveConfig(config, file);
		process.stdout.write(`Shared ${resolved} as ${id}. Start the daemon to serve it.\n`);
		return;
	}

	if (action === 'remove') {
		const id = args.rest[1];
		if (!id) throw new Error('folders remove needs an id, see `riozelink folders list`');
		if (!config.folders[id]) throw new Error(`no shared folder with id ${id}`);
		delete config.folders[id];
		await saveConfig(config, file);
		process.stdout.write(`Removed ${id}.\n`);
		return;
	}

	throw new Error(`unknown folders action: ${action}`);
}

async function clients(args: ParsedArgs): Promise<void> {
	const file = configFilePath();
	const config = await loadConfig(file);
	const action = args.rest[0] ?? 'list';

	if (action === 'list') {
		const entries = Object.entries(config.authorizedClients);
		if (entries.length === 0) {
			process.stdout.write('No browsers are paired yet. Start the daemon and type its words.\n');
			return;
		}
		for (const [fingerprint, client] of entries) {
			process.stdout.write(`${client.label}\t${fingerprint.slice(0, 16)}…\n`);
		}
		return;
	}

	if (action === 'revoke') {
		const needle = (args.rest[1] ?? '').trim().toLowerCase();
		if (!needle) throw new Error('clients revoke needs a name or a fingerprint');
		const match = Object.entries(config.authorizedClients).find(
			([fingerprint, client]) =>
				fingerprint.toLowerCase().startsWith(needle) || client.label.toLowerCase() === needle
		);
		if (!match) throw new Error(`no paired browser matches ${needle}`);
		delete config.authorizedClients[match[0]];
		await saveConfig(config, file);
		process.stdout.write(`Revoked ${match[1].label}. Its room is gone the next time the daemon starts.\n`);
		return;
	}

	throw new Error(`unknown clients action: ${action}`);
}

async function status(): Promise<void> {
	const config = await loadConfig(configFilePath());
	process.stdout.write(`config    ${displayPath(configFilePath())}\n`);
	process.stdout.write(`host      ${config.hostName}\n`);
	process.stdout.write(`relay     ${config.relay}\n`);
	const shares = Object.entries(config.folders);
	process.stdout.write(`shares    ${shares.length}\n`);
	for (const [id, share] of shares) {
		process.stdout.write(`  ${id}\t${displayPath(share.path)}\n`);
	}
	const clients = Object.entries(config.authorizedClients);
	process.stdout.write(`clients   ${clients.length} paired\n`);
	for (const [fingerprint, client] of clients) {
		process.stdout.write(`  ${client.label}\t${fingerprint.slice(0, 12)}…\n`);
	}
	process.stdout.write(`anki      ${config.anki.enabled ? `on (port ${config.anki.port})` : 'off'}\n`);
	process.stdout.write(
		`ai        ${config.ai.enabled ? 'on' : 'off'} · ${config.ai.provider} · ${config.ai.model}${config.ai.apiKey ? ` · key ${maskKey(config.ai.apiKey)}` : ' · no key'}\n`
	);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.flags.has('help') || args.flags.has('h') || args.command === 'help') {
		printHelp();
		return;
	}
	if (args.flags.has('version') || args.flags.has('v') || args.command === 'version') {
		process.stdout.write(`${HOST_VERSION}\n`);
		return;
	}
	switch (args.command) {
		case 'serve':
			await serve(args);
			return;
		case 'relay':
			await relay(args);
			return;
		case 'folders':
			await folders(args);
			return;
		case 'clients':
			await clients(args);
			return;
		case 'status':
			await status();
			return;
		default:
			process.stderr.write(`Unknown command: ${args.command}\n\n`);
			printHelp();
			process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
