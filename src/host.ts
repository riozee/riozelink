/**
 * The daemon itself.
 *
 * One identity, one config file, one signaling server, one set of shared folders. The host dials
 * *out*: it registers one peer id for the pairing code and one for every browser it has paired
 * with, so nothing here ever asks the user for an address, a port, or a network that happens to be
 * local.
 *
 * A pairing code is minted, never standing. One is made at startup and one whenever the user asks
 * for another, it lives for three minutes, and nothing renews it. When it expires or a browser uses
 * it, the room it named comes down and the daemon is left registered only under the ids it shares
 * with browsers it already knows. That quiet default is the point: the one id in this design whose
 * secret is small enough to attack is the one that exists only while somebody is being let in.
 *
 * The code is the only secret that ever appears in a terminal. Returning clients meet the host
 * under an id named after both their fingerprints, and authenticate with their own key.
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
	isOfferPayload,
	linkId,
	pairId,
	pairProof,
	PROTOCOL_VERSION,
	type AnkiStatusReply,
	type RpcSubsystem,
	type SignalPayload,
	type StatusInfoReply
} from './protocol.ts';
import { SignalLink } from './signal.ts';
import { ClientSession, type SessionHost } from './session.ts';
import { ShareWatcher, sharesReply, sweepPartials } from './vfs.ts';
import { displayPath, formatDuration, truncate } from './util.ts';
import { generatePhrase } from './words.ts';

export const HOST_VERSION = '0.3.0';

const PAIRING_TTL_MS = 3 * 60_000;
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
	/** Overrides the signaling server URL in the config file. */
	signal?: string;
	/** Overrides how long a minted code is good for. The tests use it. */
	pairingTtlMs?: number;
	hostName?: string;
	iceServers?: string[];
	onLog?(entry: LogEntry): void;
	onUpdate?(): void;
}

/** One registration with the signaling server, plus whatever came out of it. */
interface HostLink {
	/** The peer id this link holds. */
	id: string;
	kind: 'pair' | 'link';
	/** The client label for a client link, `pairing` for the code one. */
	label: string;
	link: SignalLink;
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
	/** How long a minted code is good for. Three minutes unless a test says otherwise. */
	private readonly pairingTtlMs: number;
	private readonly sessions = new Map<string, ClientSession>();
	private readonly links = new Map<string, HostLink>();
	private readonly watcher: ShareWatcher;
	private readonly logs: LogEntry[] = [];
	private readonly listeners = new Set<() => void>();
	private signalBase: string;
	/** The live code, or null when nothing is listening for one. */
	private pairingPhrase: string | null = generatePhrase();
	private pairingCreatedAt = Date.now();
	private pairingFailures = 0;
	private pairingTimer: NodeJS.Timeout | null = null;
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
		this.pairingTtlMs = options.pairingTtlMs ?? PAIRING_TTL_MS;
		this.configDir = configDir;
		this.configPath = path.join(configDir, 'config.json');
		this.config = config;
		this.identity = identity;
		this.hostName = options.hostName?.trim() || config.hostName || 'RiozeLink host';
		if (this.hostName !== config.hostName) {
			this.config.hostName = this.hostName;
		}
		this.signalBase = options.signal?.trim() || config.signal;
		if (this.signalBase !== config.signal) this.config.signal = this.signalBase;
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
		await this.syncLinks();
		this.armPairingExpiry();
		this.startAnkiWatch();
		void sweepPartials(this.config.folders).then((removed) => {
			if (removed > 0) {
				this.log('info', `cleaned up ${removed} unfinished upload${removed === 1 ? '' : 's'}`);
			}
		});
		this.log('info', `RiozeLink ${this.hostVersion} ready for ${this.hostName}`);
		this.log('info', `meeting point: ${this.signalBase}`);
		this.notify();
	}

	async stop(reason = 'shutting down'): Promise<void> {
		this.watcher.stop();
		this.ai.cancelAll();
		this.clearPairingTimer();
		if (this.ankiTimer) clearInterval(this.ankiTimer);
		this.ankiTimer = null;
		for (const session of [...this.sessions.values()]) session.dispose(reason);
		for (const link of this.links.values()) link.link.close(reason);
		this.links.clear();
		this.log('info', reason);
		this.notify();
	}

	/* -------------------------------------------------------------------- links ------- */

	/**
	 * Makes the registrations on the signaling server match the ones this host should be holding: a
	 * pairing room while a code is live, plus one quiet id per paired client. Called at boot,
	 * whenever a code is minted or retired, and whenever the client list changes.
	 *
	 * The pairing room being absent from `desired` is what takes it off the server. Nothing else has
	 * to remember to close it.
	 */
	async syncLinks(): Promise<void> {
		const desired = new Map<string, { kind: 'pair' | 'link'; label: string }>();
		const code = this.pairingCode();
		if (code) desired.set(await pairId(code), { kind: 'pair', label: 'pairing' });
		for (const [fingerprint, client] of Object.entries(this.config.authorizedClients)) {
			desired.set(await linkId(this.identity.fingerprintHex, fingerprint), {
				kind: 'link',
				label: client.label
			});
		}

		for (const [id, entry] of [...this.links]) {
			const wanted = desired.get(id);
			if (wanted?.kind === entry.kind) continue;
			this.links.delete(id);
			// A client link only closes when the browser behind it was revoked, so its session goes
			// with it. The pairing link is different: retiring the code must never hang up on the
			// browser that just paired through it, and the DataChannel does not need the signaling
			// server anymore anyway.
			if (entry.kind === 'link') {
				entry.session?.dispose('its registration closed');
				entry.peer?.close('its registration closed');
			}
			entry.link.close('registration closed');
		}

		for (const [id, wanted] of desired) {
			const existing = this.links.get(id);
			if (!existing) {
				this.openLink(id, wanted.kind, wanted.label);
				continue;
			}
			// A registration that gave up has to be rebuilt, or the id stays dark forever and the
			// browsers that belong to it find nobody home.
			if (!existing.link.online && !existing.link.retrying) {
				existing.link.close('reopening');
				this.links.delete(id);
				this.openLink(id, wanted.kind, wanted.label);
			}
		}
	}

	private openLink(id: string, kind: 'pair' | 'link', label: string): void {
		const entry: HostLink = {
			id,
			kind,
			label,
			link: null as unknown as SignalLink,
			peer: null,
			session: null
		};
		this.links.set(id, entry);
		entry.link = new SignalLink({
			base: this.signalBase,
			id,
			onSignal: (payload, from) => void this.handleSignal(entry, payload, from),
			onPeerLeft: (from) => this.log('info', `${from} left, or its offer expired`),
			onOpen: () => this.notify(),
			onLost: (reason) => this.log('warn', `${reason} — the registration stays and retries`),
			onTaken: () =>
				this.log(
					'error',
					kind === 'link'
						? `another daemon with this identity is already registered as ${label}`
						: 'another daemon with this identity is already registered. Stop it and start again.'
				),
			log: (level, message) => this.log(level, message)
		});
		entry.link.connect();
	}

	private async handleSignal(entry: HostLink, data: SignalPayload, from: string): Promise<void> {
		// A browser that lost an answer starts over with a new `connectionId`, and the peer from
		// the lost attempt is silent on purpose (one offer is answered once). Left alone it would
		// eat every later attempt until its own ICE gave up, which is how a link can look dead
		// while both ends believe they are talking. A different connection id means the old peer
		// has nothing left to say, so it goes.
		if (
			entry.peer &&
			isOfferPayload(data) &&
			entry.peer.remoteConnectionId !== undefined &&
			data.connectionId !== entry.peer.remoteConnectionId
		) {
			this.log('info', `a new attempt from ${from}; letting the stalled one go`);
			entry.peer.close('a new attempt arrived');
			entry.peer = null;
		}
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
					this.log('info', `the ${entry.kind} link with ${from} ended (${reason})`);
				},
				log: (message) => this.log('info', message)
			});
		}
		await entry.peer.handleSignal(data);
	}

	private attachChannel(entry: HostLink, channel: RTCDataChannel): void {
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
		for (const entry of this.links.values()) {
			if (entry.session !== session) continue;
			entry.session = null;
			// The peer has to go with it. A peer that already answered one offer ignores the next one
			// (`if (offered) return`), so leaving it behind would eat every reconnect until it
			// happened to fail on its own.
			entry.peer?.close('its session ended');
			entry.peer = null;
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

	/**
	 * The live code, or null when nothing is listening.
	 *
	 * Expiry is read here as well as on the timer, so a code can never reach a proof or a screen
	 * after its three minutes are up, however late the timer happens to run.
	 */
	pairingCode(): string | null {
		if (!this.pairingPhrase) return null;
		if (Date.now() - this.pairingCreatedAt > this.pairingTtlMs) return null;
		return this.pairingPhrase;
	}

	pairingRemainingMs(): number {
		if (!this.pairingPhrase) return 0;
		return Math.max(0, this.pairingCreatedAt + this.pairingTtlMs - Date.now());
	}

	/**
	 * Makes a fresh code and opens the room it names. The only way a code ever appears, and the only
	 * thing that ever opens a pairing room.
	 */
	mintPairingCode(): void {
		this.pairingPhrase = generatePhrase();
		this.pairingCreatedAt = Date.now();
		this.pairingFailures = 0;
		this.armPairingExpiry();
		this.log('info', 'a pairing code is up');
		void this.syncLinks();
		this.notify();
	}

	/**
	 * Retires the code and takes the room down. Nothing makes another one.
	 *
	 * Kept public on purpose: `consumePairingPhrase` used to roll a replacement here, which is
	 * exactly the always-on behaviour this is meant to end.
	 */
	retirePairingCode(reason: string): void {
		this.clearPairingTimer();
		if (!this.pairingPhrase) return;
		this.pairingPhrase = null;
		this.pairingFailures = 0;
		this.log('info', `${reason}. No pairing room is open now`);
		void this.syncLinks();
		this.notify();
	}

	private armPairingExpiry(): void {
		this.clearPairingTimer();
		this.pairingTimer = setTimeout(() => {
			this.pairingTimer = null;
			this.retirePairingCode('the pairing code expired');
		}, this.pairingRemainingMs());
		this.pairingTimer.unref?.();
	}

	private clearPairingTimer(): void {
		if (this.pairingTimer) clearTimeout(this.pairingTimer);
		this.pairingTimer = null;
	}

	/**
	 * The client proves it knows the code by HMAC-ing the host nonce with a key stretched from it.
	 * The code itself never crosses the wire, the comparison takes the same time whether the first or
	 * the last character was wrong, and a code that has already lapsed answers with a plain no.
	 */
	async verifyPairingProof(proof: string, hostNonce: string): Promise<boolean> {
		const code = this.pairingCode();
		if (!code || !proof || !hostNonce) return false;
		const expected = await pairProof(code, hostNonce);
		if (expected.length !== proof.length) return false;
		return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(proof, 'utf8'));
	}

	retireUsedPairingCode(): void {
		this.retirePairingCode('a browser paired');
	}

	pairingFailed(): void {
		this.pairingFailures += 1;
		if (this.pairingFailures >= MAX_PAIRING_FAILURES) {
			this.retirePairingCode('too many wrong codes');
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
			signal: this.signalBase,
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

	signalUrl(): string {
		return this.signalBase;
	}

	/** How many of this host's ids are registered with the signaling server right now. */
	anchoredLinks(): number {
		let count = 0;
		for (const entry of this.links.values()) if (entry.link.online) count += 1;
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
