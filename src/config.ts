/**
 * `~/.config/riozelink/config.json` — the one file the daemon owns.
 *
 * It holds what the user shared, which clients they paired with, and the AI settings. It is
 * written with `0600` because an API key lives in it, and the file is private to the user.
 *
 * `RIOZELINK_CONFIG_DIR` moves the whole thing, which is what the tests use so they never touch
 * a real home directory.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { homedir } from 'node:os';
import type { AiProvider } from './protocol.ts';
import { slugify } from './util.ts';

export interface ShareRecord {
	label: string;
	path: string;
}

export interface AnkiConfig {
	enabled: boolean;
	port: number;
}

export interface AiConfig {
	/** The user's toggle. Off means the gateway refuses to send anything. */
	enabled: boolean;
	provider: AiProvider;
	endpoint: string;
	model: string;
	/** Write-only from the client's point of view. Never sent back in full. */
	apiKey: string;
}

export interface AuthorizedClient {
	label: string;
	/** Epoch ms. */
	pairedAt: number;
}

export interface HostConfig {
	version: 1;
	hostName: string;
	folders: Record<string, ShareRecord>;
	anki: AnkiConfig;
	ai: AiConfig;
	authorizedClients: Record<string, AuthorizedClient>;
}

export const CONFIG_VERSION = 1;

export const DEFAULT_ENDPOINTS: Record<AiProvider, string> = {
	ollama: 'http://127.0.0.1:11434',
	openai: 'https://api.openai.com'
};

export const DEFAULT_MODELS: Record<AiProvider, string> = {
	ollama: 'llama3.2',
	openai: 'gpt-4o-mini'
};

export function configDirectory(): string {
	return process.env.RIOZELINK_CONFIG_DIR ?? path.join(homedir(), '.config', 'riozelink');
}

export function configFilePath(): string {
	return path.join(configDirectory(), 'config.json');
}

export function identityFilePath(): string {
	return path.join(configDirectory(), 'identity.json');
}

export function defaultConfig(): HostConfig {
	return {
		version: CONFIG_VERSION,
		hostName: hostname(),
		folders: {},
		anki: { enabled: false, port: 8765 },
		ai: {
			enabled: false,
			provider: 'ollama',
			endpoint: DEFAULT_ENDPOINTS.ollama,
			model: DEFAULT_MODELS.ollama,
			apiKey: ''
		},
		authorizedClients: {}
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The file is meant to be edited by hand, so every field is read defensively and anything
 * unreadable falls back to its default instead of taking the daemon down.
 */
export function normalizeConfig(raw: unknown): HostConfig {
	const config = defaultConfig();
	if (!isRecord(raw)) return config;

	if (typeof raw.hostName === 'string' && raw.hostName.trim())
		config.hostName = raw.hostName.trim();

	if (isRecord(raw.folders)) {
		for (const [id, value] of Object.entries(raw.folders)) {
			if (!isRecord(value)) continue;
			const folderPath = typeof value.path === 'string' ? value.path : null;
			if (!folderPath) continue;
			const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim() : id;
			config.folders[id] = { label, path: folderPath };
		}
	}

	if (isRecord(raw.anki)) {
		if (typeof raw.anki.enabled === 'boolean') config.anki.enabled = raw.anki.enabled;
		if (typeof raw.anki.port === 'number' && Number.isInteger(raw.anki.port)) {
			config.anki.port = raw.anki.port;
		}
	}

	if (isRecord(raw.ai)) {
		if (typeof raw.ai.enabled === 'boolean') config.ai.enabled = raw.ai.enabled;
		if (raw.ai.provider === 'ollama' || raw.ai.provider === 'openai') {
			config.ai.provider = raw.ai.provider;
		}
		if (typeof raw.ai.endpoint === 'string' && raw.ai.endpoint.trim()) {
			config.ai.endpoint = raw.ai.endpoint.trim().replace(/\/+$/, '');
		}
		if (typeof raw.ai.model === 'string' && raw.ai.model.trim())
			config.ai.model = raw.ai.model.trim();
		if (typeof raw.ai.apiKey === 'string') config.ai.apiKey = raw.ai.apiKey;
	}

	if (isRecord(raw.authorizedClients)) {
		for (const [fingerprint, value] of Object.entries(raw.authorizedClients)) {
			if (!isRecord(value)) continue;
			const label =
				typeof value.label === 'string' && value.label.trim() ? value.label.trim() : 'Browser';
			const pairedAt = typeof value.pairedAt === 'number' ? value.pairedAt : Date.now();
			config.authorizedClients[fingerprint] = { label, pairedAt };
		}
	}

	return config;
}

export async function loadConfig(file: string = configFilePath()): Promise<HostConfig> {
	try {
		const text = await readFile(file, 'utf8');
		return normalizeConfig(JSON.parse(text));
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return defaultConfig();
		throw error;
	}
}

/** Written through a temp file so a crash mid-write cannot leave a half JSON behind. */
export async function saveConfig(
	config: HostConfig,
	file: string = configFilePath()
): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.tmp`;
	await writeFile(temp, `${JSON.stringify(config, null, '\t')}\n`, {
		encoding: 'utf8',
		mode: 0o600
	});
	await chmod(temp, 0o600).catch(() => undefined);
	await rename(temp, file);
}

/** `Notes 2026` → `notes-2026`, and `notes-2026-2` when that is taken. */
export function uniqueShareId(config: HostConfig, label: string): string {
	const base = slugify(label);
	if (!config.folders[base]) return base;
	let index = 2;
	while (config.folders[`${base}-${index}`]) index += 1;
	return `${base}-${index}`;
}

/** The same, but against a list of ids that only live for this session (mount points). */
export function uniqueId(base: string, taken: (id: string) => boolean): string {
	if (!taken(base)) return base;
	let index = 2;
	while (taken(`${base}-${index}`)) index += 1;
	return `${base}-${index}`;
}
