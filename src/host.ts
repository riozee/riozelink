/**
 * The daemon itself.
 *
 * One identity, one config file, one signaling server, one set of shared folders. Clients come
 * and go; the host keeps their sessions in a map and hands each of them the same services while
 * sharing nothing between them.
 *
 * The pairing code is the only secret that ever appears in a terminal. It lives for fifteen
 * minutes or until a client successfully pairs, whichever comes first, and ten failed attempts
 * replace it early. After that the code is dead weight: returning clients authenticate with their
 * own key, not with the code.
 */
import { timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import type { RTCDataChannel } from 'werift';
import { AiService } from './ai.ts';
import { AnkiService } from './anki.ts';
import {
	configDirectory,
	loadConfig,
	saveConfig,
	uniqueShareId,
	type HostConfig,
	type ShareRecord
} from './config.ts';
import { HostError } from './errors.ts';
import { loadOrCreateIdentity, type HostIdentity } from './identity.ts';
import { createPeerLink, type PeerLink } from './peer.ts';
import { PROTOCOL_VERSION, type RpcSubsystem, type StatusInfoReply } from './protocol.ts';
import { ClientSession, type SessionHost } from './session.ts';
import {
	createSignalingServer,
	type SignalingConnection,
	type SignalingServer
} from './signaling.ts';
import { ShareWatcher, sharesReply, sweepPartials } from './vfs.ts';
import {
	displayPath,
	formatDuration,
	hashSecret,
	randomPairingCode,
	truncate
} from './util.ts';

export const HOST_VERSION = '0.1.0';

const PAIRING_TTL_MS = 15 * 60_000;
const MAX_PAIRING_FAILURES = 10;
const MAX_LOG_LINES = 200;
const CHANNEL_TIMEOUT_MS = 45_000;

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
	seq: number;
	at: number;
	level: LogLevel;
	message: string;
}

export interface RiozeLinkHostOptions {
	/** Moves `config.json` and `identity.json` somewhere else. The tests use it. */
	configDir?: string;
	/** `0` asks the OS for a free port. */
	port?: number;
	/** Bind address of the signaling server. */
	host?: string;
	hostName?: string;
	iceServers?: string[];
	onLog?(entry: LogEntry): void;
	onUpdate?(): void;
}

export class RiozeLinkHost implements SessionHost {
	readonly config: HostConfig;
	readonly identity: HostIdentity;
	readonly hostName: string;
	readonly hostVersion = HOST_VERSION;
	readonly configDir: string;
	readonly configPath: string;
	readonly anki: AnkiService;
	readonly ai: AiService;

	private readonly options: RiozeLinkHostOptions;
	private readonly sessions = new Map<string, ClientSession>();
	private readonly links = new Map<string, PeerLink>();
	private readonly channelTimeouts = new Map<string, NodeJS.Timeout>();
	private readonly watcher: ShareWatcher;
	private readonly logs: LogEntry[] = [];
	private readonly listeners = new Set<() => void>();
	private server: SignalingServer | null = null;
	private pairingCode = randomPairingCode();
	private pairingCreatedAt = Date.now();
	private pairingFailures = 0;
	private logSeq = 0;
	private readonly startedAt = Date.now();

	private constructor(
		options: RiozeLinkHostOptions,
		configDir: string,
		config: HostConfig,
		identity: HostIdentity
	) {
		this.options = options;
		this.configDir = configDir;
		this.configPath = path.join(configDir, 'config.json');
		this.config = config;
		this.identity = identity;
		this.hostName = options.hostName?.trim() || config.hostName || 'RiozeLink host';
		if (this.hostName !== config.hostName) {
			this.config.hostName = this.hostName;
		}
		const hostServices = {
			config: this.config,
			save: () => this.save()
		};
		this.anki = new AnkiService(hostServices);
		this.ai = new AiService(hostServices);
		this.watcher = new ShareWatcher(
			(events) => {
				for (const event of events) this.broadcastEvent('vfs', 'changed', event);
			},
			(message) => this.log('warn', message)
		);
	}

	static async create(options: RiozeLinkHostOptions = {}): Promise<RiozeLinkHost> {
		const configDir = options.configDir ?? configDirectory();
		const identity = await loadOrCreateIdentity(configDir);
		const config = await loadConfig(path.join(configDir, 'config.json'));
		return new RiozeLinkHost(options, configDir, config, identity);
	}

	/* ------------------------------------------------------------------ lifecycle ------ */

	async start(): Promise<void> {
		this.server = await createSignalingServer({
			port: this.options.port ?? this.config.port,
			host: this.options.host ?? '0.0.0.0',
			info: {
				name: this.hostName,
				version: this.hostVersion,
				fingerprint: this.identity.fingerprintHex
			},
			resolveRoom: (room) => this.resolveRoom(room),
			onConnection: (connection) => this.handleConnection(connection),
			log: (level, message) => this.log(level, message)
		});
		this.watcher.update(this.config.folders);
		void sweepPartials(this.config.folders).then((removed) => {
			if (removed > 0) this.log('info', `cleaned up ${removed} unfinished upload${removed === 1 ? '' : 's'}`);
		});
		this.log('info', `RIozeLink ${this.hostVersion} ready for ${this.hostName}`);
		this.notify();
	}

	async stop(reason = 'shutting down'): Promise<void> {
		this.watcher.stop();
		this.ai.cancelAll();
		for (const session of [...this.sessions.values()]) session.dispose(reason);
		for (const link of this.links.values()) link.close(reason);
		this.links.clear();
		await this.server?.close();
		this.server = null;
		this.log('info', reason);
		this.notify();
	}

	/* ------------------------------------------------------------------- clients ------- */

	private handleConnection(connection: SignalingConnection): void {
		this.log('info', `${connection.clientName} joined the ${connection.kind} room`);
		const link = createPeerLink({
			iceServers: this.options.iceServers ?? [],
			send: (data) => connection.send({ t: 'signal', data }),
			onChannel: (channel) => {
				this.clearChannelTimeout(connection.id);
				this.attachChannel(connection, channel);
			},
			onClosed: (reason) => {
				this.links.delete(connection.id);
				this.log('info', `link with ${connection.clientName} ended (${reason})`);
			},
			log: (message) => this.log('info', message)
		});
		this.links.set(connection.id, link);

		// A client that joins and never offers is not a client.
		this.channelTimeouts.set(
			connection.id,
			setTimeout(() => {
				if (!this.links.has(connection.id)) return;
				link.close('no WebRTC offer arrived');
				connection.close('no WebRTC offer arrived');
			}, CHANNEL_TIMEOUT_MS)
		);

		connection.onMessage((message) => {
			if (message.t !== 'signal') return;
			if (message.data.type === 'offer') this.clearChannelTimeout(connection.id);
			void link.handleSignal(message.data);
		});
		connection.onClose(() => {
			this.clearChannelTimeout(connection.id);
			const active = this.links.get(connection.id);
			if (active) {
				active.close('the client left');
				this.links.delete(connection.id);
			}
		});
	}

	private clearChannelTimeout(id: string): void {
		const pending = this.channelTimeouts.get(id);
		if (!pending) return;
		clearTimeout(pending);
		this.channelTimeouts.delete(id);
	}

	private attachChannel(connection: SignalingConnection, channel: RTCDataChannel): void {
		const session = new ClientSession(channel, this, connection.kind, connection.clientName);
		this.sessions.set(session.id, session);
		this.notify();
	}

	sessionClosed(session: ClientSession): void {
		this.sessions.delete(session.id);
		this.notify();
	}

	readyClients(): number {
		let count = 0;
		for (const session of this.sessions.values()) if (session.phase === 'ready') count += 1;
		return count;
	}

	clientsChanged(): void {
		this.broadcastEvent('status', 'clients', { connectedClients: this.readyClients() });
		this.notify();
	}

	broadcastEvent(subsystem: RpcSubsystem, action: string, payload: unknown): void {
		for (const session of this.sessions.values()) {
			if (session.phase === 'ready') session.emit(subsystem, action, payload);
		}
	}

	/* -------------------------------------------------------------------- shares ------- */

	shares(): Record<string, ShareRecord> {
		return this.config.folders;
	}

	async createShare(absPath: string, label: string): Promise<{ id: string; share: ShareRecord }> {
		const resolved = path.resolve(absPath.trim());
		const existing = Object.entries(this.config.folders).find(
			([, share]) => share.path === resolved
		);
		if (existing) return { id: existing[0], share: existing[1] };
		const info = await stat(resolved).catch(() => null);
		if (!info) throw new HostError(`there is nothing at ${resolved}`, 'not-found');
		if (!info.isDirectory()) throw new HostError(`${resolved} is not a folder`, 'invalid');
		const cleanLabel = truncate(label.trim() || path.basename(resolved) || resolved, 64);
		const id = uniqueShareId(this.config, cleanLabel);
		const share = { label: cleanLabel, path: resolved };
		this.config.folders[id] = share;
		await this.save();
		this.watcher.update(this.config.folders);
		this.broadcastEvent('vfs', 'shares', sharesReply(this.config.folders));
		this.notify();
		return { id, share };
	}

	async removeShare(id: string): Promise<void> {
		if (!this.config.folders[id]) {
			throw new HostError(`unknown shared folder: ${id}`, 'not-found');
		}
		delete this.config.folders[id];
		await this.save();
		this.watcher.update(this.config.folders);
		this.broadcastEvent('vfs', 'shares', sharesReply(this.config.folders));
		this.notify();
	}

	/* ------------------------------------------------------------------- pairing ------- */

	private refreshPairingCode(): void {
		if (Date.now() - this.pairingCreatedAt > PAIRING_TTL_MS) {
			this.pairingCode = randomPairingCode();
			this.pairingCreatedAt = Date.now();
			this.pairingFailures = 0;
			this.log('info', 'the pairing code expired and was replaced');
			this.notify();
		}
	}

	currentPairingCode(): string {
		this.refreshPairingCode();
		return this.pairingCode;
	}

	pairingRemainingMs(): number {
		this.refreshPairingCode();
		return Math.max(0, this.pairingCreatedAt + PAIRING_TTL_MS - Date.now());
	}

	rotatePairingCode(): void {
		this.pairingCode = randomPairingCode();
		this.pairingCreatedAt = Date.now();
		this.pairingFailures = 0;
		this.log('info', 'a new pairing code is up');
		this.notify();
	}

	verifyPairingCode(input: string): boolean {
		this.refreshPairingCode();
		const given = hashSecret(input);
		const current = hashSecret(this.pairingCode);
		return given.length === current.length && timingSafeEqual(given, current);
	}

	consumePairingCode(): void {
		// One successful pairing retires the code; the next client needs a fresh one.
		this.rotatePairingCode();
	}

	pairingFailed(): void {
		this.pairingFailures += 1;
		if (this.pairingFailures >= MAX_PAIRING_FAILURES) {
			this.log('warn', 'too many wrong pairing codes; a new code is up');
			this.rotatePairingCode();
		}
	}

	private resolveRoom(room: string): 'pair' | 'host' | null {
		const trimmed = room.trim();
		if (trimmed === `host:${this.identity.fingerprintHex}`) return 'host';
		if (trimmed.startsWith('pair:')) {
			const code = trimmed.slice('pair:'.length);
			if (this.verifyPairingCode(code)) return 'pair';
		}
		return null;
	}

	/* -------------------------------------------------------------------- status ------- */

	info(): StatusInfoReply {
		return {
			hostName: this.hostName,
			hostVersion: this.hostVersion,
			protocol: PROTOCOL_VERSION,
			uptimeMs: Date.now() - this.startedAt,
			connectedClients: this.readyClients(),
			platform: `${process.platform} ${process.arch}`,
			shares: sharesReply(this.config.folders).shares,
			ankiEnabled: this.config.anki.enabled,
			ai: {
				provider: this.config.ai.provider,
				model: this.config.ai.model,
				keySet: this.config.ai.apiKey.length > 0
			}
		};
	}

	address(): string {
		const port = this.server?.port ?? this.options.port ?? this.config.port;
		return `ws://${this.lanAddress()}:${port}`;
	}

	/** The port the signaling server actually bound. `0` means the OS chose one. */
	get port(): number {
		return this.server?.port ?? this.options.port ?? this.config.port;
	}

	pairingLink(): string {
		const params = new URLSearchParams({ address: this.address(), code: this.currentPairingCode() });
		return `riozelink://pair?${params.toString()}`;
	}

	private lanAddress(): string {
		const nets = networkInterfaces();
		for (const entries of Object.values(nets)) {
			for (const entry of entries ?? []) {
				if (entry.family === 'IPv4' && !entry.internal) return entry.address;
			}
		}
		return '127.0.0.1';
	}

	async save(): Promise<void> {
		await saveConfig(this.config, this.configPath);
	}

	/* ----------------------------------------------------------------------- log ------- */

	log(level: LogLevel, message: string): void {
		this.logSeq += 1;
		const entry: LogEntry = { seq: this.logSeq, at: Date.now(), level, message };
		this.logs.push(entry);
		if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
		this.options.onLog?.(entry);
		this.notify();
	}

	recentLogs(limit = 8): LogEntry[] {
		return this.logs.slice(-limit);
	}

	configDisplayPath(): string {
		return displayPath(this.configPath);
	}

	pairingRemainingLabel(): string {
		return formatDuration(this.pairingRemainingMs());
	}

	onUpdate(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.options.onUpdate?.();
		for (const listener of this.listeners) listener();
	}
}
