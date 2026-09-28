/**
 * The daemon itself.
 *
 * One identity, one config file, one relay, one set of shared folders. The host dials *out*: it
 * holds a room for the pairing phrase and one room for every client it has paired with, so nothing
 * here ever asks the user for an address, a port, or a network that happens to be local.
 *
 * The pairing phrase is the only secret that ever appears in a terminal. It lives for fifteen
 * minutes or until a client successfully pairs, whichever comes first, and ten failed attempts
 * replace it early. After that the phrase is dead weight: returning clients meet the host in a
 * room named after both their fingerprints and authenticate with their own key.
 */
import { stat } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
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
import {
	linkRoom,
	pairProof,
	pairRoom,
	PROTOCOL_VERSION,
	type AnkiStatusReply,
	type RpcSubsystem,
	type SignalPayload,
	type StatusInfoReply
} from './protocol.ts';
import { RelayLink } from './relay.ts';
import { ClientSession, type SessionHost } from './session.ts';
import { ShareWatcher, sharesReply, sweepPartials } from './vfs.ts';
import { displayPath, formatDuration, truncate } from './util.ts';
import { generatePhrase } from './words.ts';

export const HOST_VERSION = '0.2.0';

const PAIRING_TTL_MS = 15 * 60_000;
const MAX_PAIRING_FAILURES = 10;
const MAX_LOG_LINES = 200;
const ANKI_PROBE_MS = 5_000;

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
	/** Overrides the relay URL in the config file. */
	relay?: string;
	hostName?: string;
	iceServers?: string[];
	onLog?(entry: LogEntry): void;
	onUpdate?(): void;
}

/** One room on the relay, plus whatever came out of it. */
interface HostRoom {
	room: string;
	kind: 'pair' | 'link';
	/** The client label for a link room, `pairing` for the phrase room. */
	label: string;
	link: RelayLink;
	peer: PeerLink | null;
	session: ClientSession | null;
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
	private readonly rooms = new Map<string, HostRoom>();
	private readonly watcher: ShareWatcher;
	private readonly logs: LogEntry[] = [];
	private readonly listeners = new Set<() => void>();
	private relay: string;
	private pairingPhrase = generatePhrase();
	private pairingCreatedAt = Date.now();
	private pairingFailures = 0;
	private ankiTimer: NodeJS.Timeout | null = null;
	private lastAnkiStatus: AnkiStatusReply | null = null;
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
		this.relay = options.relay?.trim() || config.relay;
		if (this.relay !== config.relay) this.config.relay = this.relay;
		const hostServices = {
			config: this.config,
			save: () => this.save(),
			log: (message: string) => this.log('info', message)
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
		this.watcher.update(this.config.folders);
		await this.syncRooms();
		this.startAnkiWatch();
		void sweepPartials(this.config.folders).then((removed) => {
			if (removed > 0) {
				this.log('info', `cleaned up ${removed} unfinished upload${removed === 1 ? '' : 's'}`);
			}
		});
		this.log('info', `RiozeLink ${this.hostVersion} ready for ${this.hostName}`);
		this.log('info', `meeting point: ${this.relay}`);
		this.notify();
	}

	async stop(reason = 'shutting down'): Promise<void> {
		this.watcher.stop();
		this.ai.cancelAll();
		if (this.ankiTimer) clearInterval(this.ankiTimer);
		this.ankiTimer = null;
		for (const session of [...this.sessions.values()]) session.dispose(reason);
		for (const room of this.rooms.values()) room.link.close(reason);
		this.rooms.clear();
		this.log('info', reason);
		this.notify();
	}

	/* -------------------------------------------------------------------- rooms ------- */

	/**
	 * Makes the rooms on the relay match the rooms this host should be holding: the live pairing
	 * phrase, plus one quiet room per paired client. Called at boot, after a phrase rotates, and
	 * whenever the client list changes.
	 */
	async syncRooms(): Promise<void> {
		const desired = new Map<string, { kind: 'pair' | 'link'; label: string }>();
		desired.set(await pairRoom(this.pairingPhrase), { kind: 'pair', label: 'pairing' });
		for (const [fingerprint, client] of Object.entries(this.config.authorizedClients)) {
			desired.set(await linkRoom(this.identity.fingerprintHex, fingerprint), {
				kind: 'link',
				label: client.label
			});
		}

		for (const [room, entry] of [...this.rooms]) {
			const wanted = desired.get(room);
			if (wanted?.kind === entry.kind) continue;
			this.rooms.delete(room);
			// A link room only closes when the client behind it was revoked, so its session goes
			// with it. A pair room is different: retiring the phrase must never hang up on the
			// browser that just paired through it, and the DataChannel does not need the relay
			// anymore anyway.
			if (entry.kind === 'link') {
				entry.session?.dispose('its room closed');
				entry.peer?.close('its room closed');
			}
			entry.link.close('room closed');
		}

		for (const [room, wanted] of desired) {
			if (this.rooms.has(room)) continue;
			this.openRoom(room, wanted.kind, wanted.label);
		}
	}

	private openRoom(room: string, kind: 'pair' | 'link', label: string): void {
		const entry: HostRoom = {
			room,
			kind,
			label,
			link: null as unknown as RelayLink,
			peer: null,
			session: null
		};
		this.rooms.set(room, entry);
		entry.link = new RelayLink({
			url: this.relay,
			room,
			role: 'host',
			name: this.hostName,
			onSignal: (data) => void this.handleSignal(entry, data),
			onPeer: (event) => {
				if (event === 'joined') {
					this.log(
						'info',
						kind === 'pair'
							? 'a browser is in the pairing room, waiting for the words'
							: `a browser is reconnecting as ${label}`
					);
				}
			},
			onLost: (reason) => this.log('warn', `${reason} — the room stays open and retries`),
			onFatal: (reason) => this.log('error', `the relay turned the ${kind} room away: ${reason}`),
			log: (level, message) => this.log(level, message)
		});
		entry.link.connect();
	}

	private async handleSignal(entry: HostRoom, data: SignalPayload): Promise<void> {
		if (!entry.peer) {
			entry.peer = createPeerLink({
				iceServers: this.options.iceServers ?? [],
				send: (payload) => entry.link.send(payload),
				onChannel: (channel) => this.attachChannel(entry, channel),
				onClosed: (reason) => {
					entry.peer = null;
					if (entry.session && entry.session.phase !== 'closed') {
						entry.session.dispose(`the link ended (${reason})`);
					}
					entry.session = null;
					this.log('info', `the link in the ${entry.kind} room ended (${reason})`);
				},
				log: (message) => this.log('info', message)
			});
		}
		await entry.peer.handleSignal(data);
	}

	private attachChannel(entry: HostRoom, channel: RTCDataChannel): void {
		if (entry.session && entry.session.phase !== 'closed') {
			entry.session.dispose('a new link took over');
		}
		const session = new ClientSession(channel, this, entry.kind === 'pair' ? 'pair' : 'link');
		entry.session = session;
		this.sessions.set(session.id, session);
		this.notify();
	}

	sessionClosed(session: ClientSession): void {
		this.sessions.delete(session.id);
		for (const entry of this.rooms.values()) {
			if (entry.session === session) entry.session = null;
		}
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

	/* -------------------------------------------------------------------- anki -------- */

	/**
	 * Anki is a toggle, and while it is on the host keeps checking whether the desktop app is
	 * open. RiozeOS hears about every change, so its indicator lights up on its own instead of
	 * asking on a timer.
	 */
	private startAnkiWatch(): void {
		if (this.ankiTimer) clearInterval(this.ankiTimer);
		this.ankiTimer = setInterval(() => void this.ankiChanged(), ANKI_PROBE_MS);
		this.ankiTimer.unref?.();
		void this.ankiChanged();
	}

	async ankiChanged(): Promise<void> {
		const status = await this.anki.status();
		const before = this.lastAnkiStatus;
		const changed =
			!before ||
			before.enabled !== status.enabled ||
			before.reachable !== status.reachable ||
			before.version !== status.version;
		this.lastAnkiStatus = status;
		if (!changed) return;
		if (before) {
			this.log(
				'info',
				status.enabled
					? status.reachable
						? `AnkiConnect is answering (v${status.version ?? '?'})`
						: 'AnkiConnect is not answering'
					: 'the Anki bridge is off'
			);
		}
		this.broadcastEvent('anki', 'status', status);
		this.notify();
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

	private refreshPairingPhrase(): void {
		if (Date.now() - this.pairingCreatedAt > PAIRING_TTL_MS) {
			this.pairingPhrase = generatePhrase();
			this.pairingCreatedAt = Date.now();
			this.pairingFailures = 0;
			this.log('info', 'the pairing phrase expired and was replaced');
			void this.syncRooms();
			this.notify();
		}
	}

	currentPairingPhrase(): string {
		this.refreshPairingPhrase();
		return this.pairingPhrase;
	}

	pairingRemainingMs(): number {
		this.refreshPairingPhrase();
		return Math.max(0, this.pairingCreatedAt + PAIRING_TTL_MS - Date.now());
	}

	rotatePairing(): void {
		this.pairingPhrase = generatePhrase();
		this.pairingCreatedAt = Date.now();
		this.pairingFailures = 0;
		this.log('info', 'a new pairing phrase is up');
		void this.syncRooms();
		this.notify();
	}

	/**
	 * The client proves it knows the words by HMAC-ing the host nonce with a key stretched from
	 * the phrase. The phrase itself never crosses the wire, and the comparison still takes the
	 * same time whether the first or last character was wrong.
	 */
	async verifyPairingProof(proof: string, hostNonce: string): Promise<boolean> {
		this.refreshPairingPhrase();
		if (!proof || !hostNonce) return false;
		const expected = await pairProof(this.pairingPhrase, hostNonce);
		if (expected.length !== proof.length) return false;
		return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(proof, 'utf8'));
	}

	consumePairingPhrase(): void {
		// One successful pairing retires the phrase; the next client needs a fresh one.
		this.rotatePairing();
	}

	pairingFailed(): void {
		this.pairingFailures += 1;
		if (this.pairingFailures >= MAX_PAIRING_FAILURES) {
			this.log('warn', 'too many wrong pairings; a new phrase is up');
			this.rotatePairing();
		}
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
			relay: this.relay,
			shares: sharesReply(this.config.folders).shares,
			ankiEnabled: this.config.anki.enabled,
			ai: {
				enabled: this.config.ai.enabled,
				provider: this.config.ai.provider,
				model: this.config.ai.model,
				keySet: this.config.ai.apiKey.length > 0
			}
		};
	}

	relayUrl(): string {
		return this.relay;
	}

	/** How many of this host's rooms are sitting on the relay right now. */
	anchoredRooms(): number {
		let count = 0;
		for (const entry of this.rooms.values()) if (entry.link.online) count += 1;
		return count;
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
