/**
 * One connected client, from hello to goodbye.
 *
 * A session owns the auth exchange, the request routing, and everything that is private to one
 * client: the part files a half-finished upload is sitting in, the AI streams it started, and its
 * own idea of who it is. Two sessions share the host's services and nothing else, which is what
 * keeps two RiozeOS windows from seeing each other's traffic.
 *
 * The order is fixed. `auth:hello` proves the host to the client by signing the client's nonce.
 * Then either `auth:prove` (a returning client signs the host's nonce) or `auth:pair` (the same,
 * plus an HMAC over the nonce made with the four words the host printed). Only after that does any
 * other subsystem answer.
 */
import type { RTCDataChannel } from 'werift';
import type { AnkiService } from './anki.ts';
import type { AiService, AiStreamSink } from './ai.ts';
import type { HostConfig, ShareRecord } from './config.ts';
import { HostError, requireString, toErrorInfo } from './errors.ts';
import { fingerprintOfPublicKey, importPublicKey, sign, verify, type HostIdentity } from './identity.ts';
import {
	PROTOCOL_VERSION,
	type AiChatRequest,
	type AuthHelloPayload,
	type AuthOkPayload,
	type RpcErrorInfo,
	type RpcSubsystem,
	type RpcWire,
	type StatusInfoReply
} from './protocol.ts';
import { fromBase64, randomId, randomNonce, toBase64, truncate } from './util.ts';
import * as vfsOps from './vfs.ts';
import type { UploadTable } from './vfs.ts';

export interface SessionHost {
	readonly config: HostConfig;
	readonly identity: HostIdentity;
	readonly hostName: string;
	readonly hostVersion: string;
	save(): Promise<void>;
	log(level: 'info' | 'warn' | 'error', message: string): void;
	info(): StatusInfoReply;
	shares(): Record<string, ShareRecord>;
	/** Hands an event to every ready session. */
	broadcastEvent(subsystem: RpcSubsystem, action: string, payload: unknown): void;
	clientsChanged(): void;
	verifyPairingProof(proof: string, hostNonce: string): Promise<boolean>;
	consumePairingPhrase(): void;
	pairingFailed(): void;
	createShare(absPath: string, label: string): Promise<{ id: string; share: ShareRecord }>;
	removeShare(id: string): Promise<void>;
	/** Asks the host to re-probe Anki right now, so a toggle answers with fresh truth. */
	ankiChanged(): Promise<void>;
	sessionClosed(session: ClientSession): void;
	readonly ai: AiService;
	readonly anki: AnkiService;
}

export type SessionPhase = 'awaiting-hello' | 'awaiting-proof' | 'awaiting-pair' | 'ready' | 'closed';

const HELLO_TIMEOUT_MS = 20000;
const AUTH_TIMEOUT_MS = 60000;
const MAX_AUTH_FAILURES = 3;

function cleanName(value: unknown): string {
	if (typeof value !== 'string') return 'Browser';
	const stripped = value.replaceAll(/[\p{C}]+/gu, '').trim();
	return truncate(stripped || 'Browser', 48);
}

export class ClientSession {
	readonly id = randomId();
	readonly joinedAt = Date.now();
	phase: SessionPhase = 'awaiting-hello';
	clientName = 'Browser';
	clientLabel = '';
	fingerprint = '';
	/** How this client arrived: through the pairing phrase, or straight into its own link room. */
	readonly origin: 'pair' | 'link';

	private clientPublicKey = '';
	private hostNonce = '';
	private authFailures = 0;
	private readonly uploads: UploadTable = new Map();
	private readonly aiStreams = new Set<string>();
	private readonly helloDeadline: NodeJS.Timeout;
	private authDeadline: NodeJS.Timeout | null = null;

	constructor(
		private readonly channel: RTCDataChannel,
		private readonly host: SessionHost,
		origin: 'pair' | 'link',
		peerLabel?: string
	) {
		this.origin = origin;
		if (peerLabel) this.clientName = cleanName(peerLabel);
		channel.onMessage.subscribe((data) => this.onMessage(data));
		channel.stateChange.subscribe((state) => {
			if (state === 'closed') this.dispose('the data channel closed');
		});
		this.helloDeadline = setTimeout(() => {
			if (this.phase === 'awaiting-hello') this.dispose('no hello arrived');
		}, HELLO_TIMEOUT_MS);
	}

	/* ------------------------------------------------------------------ transport ------ */

	private sendText(text: string): void {
		if (this.phase === 'closed') return;
		if (this.channel.readyState !== 'open') return;
		try {
			this.channel.send(text);
		} catch (error) {
			this.host.log('warn', `could not send to ${this.clientLabel || this.clientName}: ${(error as Error).message}`);
		}
	}

	private reply(id: string, payload: unknown): void {
		this.sendText(JSON.stringify({ kind: 'res', id, ok: true, payload } satisfies RpcWire));
	}

	private fail(id: string, error: RpcErrorInfo): void {
		this.sendText(JSON.stringify({ kind: 'res', id, ok: false, error } satisfies RpcWire));
	}

	emit(subsystem: RpcSubsystem, action: string, payload: unknown): void {
		this.sendText(JSON.stringify({ kind: 'evt', subsystem, action, payload } satisfies RpcWire));
	}

	dispose(reason: string): void {
		if (this.phase === 'closed') return;
		this.phase = 'closed';
		clearTimeout(this.helloDeadline);
		if (this.authDeadline) clearTimeout(this.authDeadline);
		void vfsOps.cancelUploads(this.uploads);
		for (const streamId of this.aiStreams) this.host.ai.cancel(streamId);
		this.aiStreams.clear();
		try {
			this.channel.close();
		} catch {
			// Already gone.
		}
		this.host.log('info', `${this.clientLabel || this.clientName} disconnected (${reason})`);
		this.host.sessionClosed(this);
		this.host.clientsChanged();
	}

	/* ------------------------------------------------------------------- dispatch ------ */

	private onMessage(data: string | Buffer): void {
		if (this.phase === 'closed') return;
		let message: RpcWire;
		try {
			message = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) as RpcWire;
		} catch {
			this.dispose('sent something that is not JSON');
			return;
		}
		if (!message || message.kind !== 'req') {
			this.host.log('warn', `ignored a stray frame from ${this.clientName}`);
			return;
		}
		const id = typeof message.id === 'string' ? message.id : '';
		if (!id) {
			this.dispose('sent a request without an id');
			return;
		}
		void this.route(message.subsystem, message.action, message.payload)
			.then((payload) => this.reply(id, payload))
			.catch((error) => {
				const info = toErrorInfo(error);
				this.fail(id, info);
				if (info.code === 'auth') {
					this.authFailures += 1;
					if (this.authFailures >= MAX_AUTH_FAILURES || this.phase === 'awaiting-hello') {
						this.dispose(`failed to authenticate (${info.message})`);
					}
				}
			});
	}

	private async route(subsystem: RpcSubsystem, action: string, payload: unknown): Promise<unknown> {
		if (subsystem === 'auth') return this.handleAuth(action, payload);
		if (this.phase !== 'ready') {
			throw new HostError('this session has not paired yet', 'auth');
		}
		switch (subsystem) {
			case 'vfs':
				return this.handleVfs(action, payload);
			case 'anki':
				return this.handleAnki(action, payload);
			case 'ai':
				return this.handleAi(action, payload);
			case 'status':
				return this.handleStatus(action, payload);
			default:
				throw new HostError(`unknown subsystem: ${subsystem}`, 'unsupported');
		}
	}

	/* ---------------------------------------------------------------------- auth ------- */

	private async handleAuth(action: string, raw: unknown): Promise<unknown> {
		const payload = (raw ?? {}) as Record<string, unknown>;
		if (action === 'hello') return this.onHello(payload);
		if (action === 'prove') return this.onProof(payload);
		if (action === 'pair') return this.onPair(payload);
		throw new HostError(`unknown auth action: ${action}`, 'unsupported');
	}

	private async onHello(payload: Record<string, unknown>): Promise<unknown> {
		if (this.phase !== 'awaiting-hello') throw new HostError('hello was already received', 'invalid');
		const protocol = typeof payload.protocol === 'number' ? payload.protocol : 0;
		if (protocol !== PROTOCOL_VERSION) {
			throw new HostError(
				`the client speaks protocol ${protocol}, this host speaks ${PROTOCOL_VERSION}`,
				'unsupported'
			);
		}
		const publicKey = requireString(payload.publicKey, 'publicKey');
		const clientNonce = requireString(payload.clientNonce, 'clientNonce');
		try {
			await importPublicKey(publicKey);
		} catch {
			throw new HostError('the client key is not a valid P-256 public key', 'auth');
		}
		const { fingerprint, fingerprintHex } = fingerprintOfPublicKey(publicKey);
		this.clientPublicKey = publicKey;
		this.fingerprint = fingerprintHex;
		this.clientName = cleanName(payload.clientName);

		const authorized = this.host.config.authorizedClients[fingerprintHex];
		this.hostNonce = randomNonce();
		const signature = toBase64(await sign(this.host.identity, fromBase64(clientNonce)));
		this.phase = authorized ? 'awaiting-proof' : 'awaiting-pair';
		clearTimeout(this.helloDeadline);
		this.authDeadline = setTimeout(() => {
			if (this.phase !== 'ready') this.dispose('did not finish authenticating');
		}, AUTH_TIMEOUT_MS);

		this.host.log(
			'info',
			`hello from ${this.clientName} (${fingerprint})${authorized ? '' : ', waiting for the pairing code'}`
		);
		return {
			hostName: this.host.hostName,
			hostVersion: this.host.hostVersion,
			protocol: PROTOCOL_VERSION,
			publicKey: this.host.identity.publicKey,
			fingerprint: this.host.identity.fingerprint,
			signature,
			hostNonce: this.hostNonce,
			known: Boolean(authorized),
			clientLabel: authorized?.label
		};
	}

	private async verifyClientProof(signature: string): Promise<boolean> {
		return verify(this.clientPublicKey, fromBase64(signature), fromBase64(this.hostNonce));
	}

	private async onProof(payload: Record<string, unknown>): Promise<unknown> {
		if (this.phase !== 'awaiting-proof') {
			throw new HostError('this session is not waiting for a proof', 'invalid');
		}
		const signature = requireString(payload.signature, 'signature');
		if (!(await this.verifyClientProof(signature))) {
			throw new HostError('the signature did not verify', 'auth');
		}
		const stored = this.host.config.authorizedClients[this.fingerprint];
		return this.becomeReady(stored?.label ?? this.clientName);
	}

	private async onPair(payload: Record<string, unknown>): Promise<unknown> {
		if (this.phase !== 'awaiting-pair') {
			throw new HostError('this client is already known. Reconnect instead.', 'invalid');
		}
		const signature = requireString(payload.signature, 'signature');
		const proof = requireString(payload.proof, 'proof');
		const name = cleanName(payload.clientName ?? this.clientName);

		// Both checks always run, so a wrong phrase and a wrong key take the same time and answer
		// with the same words.
		const signatureOk = await this.verifyClientProof(signature);
		const phraseOk = await this.host.verifyPairingProof(proof, this.hostNonce);
		if (!signatureOk || !phraseOk) {
			this.host.pairingFailed();
			throw new HostError(
				'pairing failed. Check the four words on the host and try again.',
				'auth'
			);
		}

		this.clientName = name;
		this.host.config.authorizedClients[this.fingerprint] = {
			label: name,
			pairedAt: Date.now()
		};
		await this.host.save();
		this.host.consumePairingPhrase();
		this.host.log('info', `paired with ${name} (${this.fingerprint})`);
		return this.becomeReady(name);
	}

	private becomeReady(label: string): AuthOkPayload {
		this.phase = 'ready';
		this.clientLabel = label;
		if (this.authDeadline) clearTimeout(this.authDeadline);
		this.host.log('info', `${label} is connected`);
		this.host.clientsChanged();
		return {
			clientLabel: label,
			hostName: this.host.hostName,
			hostVersion: this.host.hostVersion,
			hostFingerprint: this.host.identity.fingerprint,
			serverTime: Date.now()
		};
	}

	/* ----------------------------------------------------------------------- vfs ------- */

	private shareOf(payload: Record<string, unknown>): ShareRecord {
		const id = requireString(payload.share, 'share');
		const record = this.host.shares()[id];
		if (!record) throw new HostError(`unknown shared folder: ${id}`, 'not-found');
		return record;
	}

	private async handleVfs(action: string, raw: unknown): Promise<unknown> {
		const payload = (raw ?? {}) as Record<string, unknown>;
		switch (action) {
			case 'list':
				return vfsOps.listShare(this.shareOf(payload), requireString(payload.path, 'path'));
			case 'stat':
				return vfsOps.statShare(this.shareOf(payload), requireString(payload.path, 'path'));
			case 'read':
				return vfsOps.readShare(this.shareOf(payload), payload);
			case 'write':
				return vfsOps.writeShare(this.uploads, this.shareOf(payload), payload);
			case 'mkdir':
				await vfsOps.mkdirShare(this.shareOf(payload), requireString(payload.path, 'path'));
				return {};
			case 'remove':
				await vfsOps.removeShare(this.shareOf(payload), requireString(payload.path, 'path'));
				return {};
			case 'rename':
				await vfsOps.renameShare(
					this.shareOf(payload),
					requireString(payload.from, 'from'),
					requireString(payload.to, 'to')
				);
				return {};
			case 'shares':
				return vfsOps.sharesReply(this.host.shares());
			case 'share-add': {
				const absPath = requireString(payload.path, 'path');
				const label =
					typeof payload.label === 'string' && payload.label.trim()
						? payload.label.trim()
						: absPath;
				const { share } = await this.host.createShare(absPath, label);
				this.host.log('info', `${this.clientLabel} shared ${absPath}`);
				return { share };
			}
			case 'share-remove': {
				const id = requireString(payload.id, 'id');
				await this.host.removeShare(id);
				this.host.log('info', `${this.clientLabel} stopped sharing ${id}`);
				return {};
			}
			default:
				throw new HostError(`unknown vfs action: ${action}`, 'unsupported');
		}
	}

	/* ---------------------------------------------------------------------- anki ------- */

	private async handleAnki(action: string, raw: unknown): Promise<unknown> {
		const payload = (raw ?? {}) as Record<string, unknown>;
		switch (action) {
			case 'status':
				return this.host.anki.status();
			case 'set-enabled': {
				const status = await this.host.anki.setEnabled(payload.enabled === true);
				void this.host.ankiChanged();
				return status;
			}
			case 'invoke':
				return this.host.anki.invoke(payload);
			default:
				throw new HostError(`unknown anki action: ${action}`, 'unsupported');
		}
	}

	/* ------------------------------------------------------------------------ ai ------- */

	private async handleAi(action: string, raw: unknown): Promise<unknown> {
		const payload = (raw ?? {}) as Record<string, unknown>;
		switch (action) {
			case 'status':
				return this.host.ai.status();
			case 'config':
				return this.host.ai.setConfig(payload);
			case 'set-key':
				return this.host.ai.setKey(requireString(payload.key, 'key'));
			case 'clear-key':
				return this.host.ai.clearKey();
			case 'chat': {
				// Refuse before anything starts, so a turned-off gateway answers with an error
				// rather than a stream that dies on its first event.
				if (!this.host.config.ai.enabled) {
					throw new HostError('the AI gateway is turned off in riozelink', 'denied');
				}
				const streamId = requireString(payload.streamId, 'streamId');
				this.aiStreams.add(streamId);
				this.host.log('info', `ai chat ${streamId} started`);
				const sink: AiStreamSink = {
					chunk: (id: string, delta: string) => this.emit('ai', 'chunk', { streamId: id, delta }),
					end: (id: string, text: string) => {
						this.aiStreams.delete(id);
						this.host.log('info', `ai chat ${id} finished (${text.length} chars)`);
						this.emit('ai', 'end', { streamId: id, text });
					},
					error: (id: string, error: RpcErrorInfo) => {
						this.aiStreams.delete(id);
						this.host.log('warn', `ai chat ${id} failed: ${error.message}`);
						this.emit('ai', 'error', { streamId: id, error });
					}
				};
				void this.host.ai
					.chat(payload as unknown as AiChatRequest, sink)
					.finally(() => this.aiStreams.delete(streamId));
				return {};
			}
			case 'cancel': {
				const streamId = requireString(payload.streamId, 'streamId');
				this.aiStreams.delete(streamId);
				this.host.ai.cancel(streamId);
				return {};
			}
			default:
				throw new HostError(`unknown ai action: ${action}`, 'unsupported');
		}
	}

	/* -------------------------------------------------------------------- status ------- */

	private async handleStatus(action: string, raw: unknown): Promise<unknown> {
		const payload = (raw ?? {}) as Record<string, unknown>;
		switch (action) {
			case 'info':
				return this.host.info();
			case 'ping':
				return { t: typeof payload.t === 'number' ? payload.t : 0 };
			default:
				throw new HostError(`unknown status action: ${action}`, 'unsupported');
		}
	}
}
