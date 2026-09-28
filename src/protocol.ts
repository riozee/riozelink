/**
 * The RiozeLink wire contract.
 *
 * One file, two runtimes. The host daemon (Bun, this repository) implements the host side; the
 * RiozeOS client (a browser app) implements the client side. They meet here, and nowhere else.
 *
 * Everything travels over one ordered WebRTC DataChannel as JSON text. A request carries an `id`
 * and gets exactly one reply with the same `id`. Events are pushed by the host and answer nothing.
 * File content rides inside those JSON messages as base64 chunks, because riozeOS reads and writes
 * whole files and a text frame is the one thing both runtimes handle identically.
 *
 * The typed surface is {@link RpcSpec}: one entry per call, keyed `subsystem:action`. Both sides
 * build their client and their dispatcher out of it, so a typo is a compile error rather than a
 * message that silently goes nowhere.
 */

export const PROTOCOL_VERSION = 1;

/** Who a message is for. `auth` runs first; everything else answers once a session is proven. */
export type RpcSubsystem = 'auth' | 'vfs' | 'anki' | 'ai' | 'status';

/**
 * The envelope of a request. A reply carries the same `id` and an `ok` flag. See {@link RpcWire}
 * for what actually travels: the three shapes share these fields and are told apart by `kind`.
 */
export interface RpcMessage<T = unknown> {
	id: string;
	subsystem: RpcSubsystem;
	action: string;
	payload: T;
}

export type RpcErrorCode =
	/** The session is not proven, or the pairing code did not match. */
	| 'auth'
	/** The host refused. A path outside the shared folders reads as this. */
	| 'denied'
	| 'not-found'
	| 'exists'
	| 'invalid'
	| 'unsupported'
	| 'io'
	| 'quota'
	/** The host is busy with another transfer of the same thing. */
	| 'busy'
	/** Nothing is listening on the other side of a loopback service. */
	| 'offline'
	| 'unknown';

export interface RpcErrorInfo {
	code: RpcErrorCode;
	message: string;
}

/** What actually crosses the DataChannel. */
export type RpcWire =
	| ({ kind: 'req' } & RpcMessage)
	| { kind: 'res'; id: string; ok: true; payload: unknown }
	| { kind: 'res'; id: string; ok: false; error: RpcErrorInfo }
	| { kind: 'evt'; subsystem: RpcSubsystem; action: string; payload: unknown };

/**
 * Read and write chunks, in raw file bytes per message.
 *
 * 45 KiB is not a round number on purpose. Base64 grows it by a third, the JSON envelope adds a
 * little more, and the result has to stay under the 64 KiB message size that some WebRTC stacks
 * advertise, Safari among them. Chunks that fit everywhere beat chunks that are fast on paper.
 */
export const VFS_CHUNK = 45 * 1024;

/* ------------------------------------------------------------------------------------------------
 * auth
 *
 * The client generates an ECDSA P-256 key pair (non-extractable private key, stored in the
 * browser). The host has one too. Hello proves the host, proof and pairing prove the client.
 * Everything is WebCrypto on both sides, so the signature formats match exactly.
 * ---------------------------------------------------------------------------------------------- */

export interface AuthHelloPayload {
	/** What the client wants to be called in the host's client list. */
	clientName: string;
	/** Client public key, SPKI DER, base64. */
	publicKey: string;
	/** Random 32 bytes, base64. The host signs these so the client can pin the host. */
	clientNonce: string;
	/** The protocol revision the client speaks. */
	protocol: number;
}

export interface AuthHelloReply {
	hostName: string;
	hostVersion: string;
	protocol: number;
	/** Host public key, SPKI DER, base64. */
	publicKey: string;
	/** `ab12 cd34 …`, derived from the public key. Stable across restarts. */
	fingerprint: string;
	/** ECDSA signature over the client nonce, so the client can verify it talks to the right host. */
	signature: string;
	/** Random 32 bytes, base64. The client signs these back to prove its key. */
	hostNonce: string;
	/** True when this client's key is already in `authorizedClients`. */
	known: boolean;
	/** The host's label for this client, when it knows it. */
	clientLabel?: string;
}

/** A returning client proves possession of its key. */
export interface AuthProvePayload {
	/** ECDSA signature over the host nonce. */
	signature: string;
}

/** A first-time client pairs with the code the host prints. */
export interface AuthPairPayload {
	code: string;
	/** ECDSA signature over the host nonce, so the key being stored is the key being used. */
	signature: string;
	clientName: string;
}

export interface AuthOkPayload {
	clientLabel: string;
	hostName: string;
	hostVersion: string;
	hostFingerprint: string;
	/** Host clock, epoch ms. */
	serverTime: number;
}

/* ------------------------------------------------------------------------------------------------
 * vfs
 *
 * Paths are POSIX and relative to a share. `/` is the share root; the host resolves them inside
 * the shared folder and refuses anything that steps out, symlinks included.
 * ---------------------------------------------------------------------------------------------- */

export interface RemoteEntry {
	name: string;
	kind: 'file' | 'dir';
	size: number;
	/** Epoch ms, or 0 when the host cannot tell. */
	mtime: number;
}

export interface VfsListRequest {
	/** Which shared folder this path lives in. */
	share: string;
	path: string;
}

export interface VfsListReply {
	entries: RemoteEntry[];
}

export interface VfsStatRequest {
	share: string;
	path: string;
}

export interface VfsStatReply {
	entry: RemoteEntry | null;
}

export interface VfsReadRequest {
	share: string;
	path: string;
	offset: number;
	length: number;
}

export interface VfsReadReply {
	/** Base64 of the slice. */
	data: string;
	/** Whole file size. */
	size: number;
	/** True when this slice reaches the end of the file. */
	done: boolean;
}

export interface VfsWriteRequest {
	share: string;
	path: string;
	offset: number;
	/** Base64 of this slice. */
	data: string;
	/** True on the final slice; the host then replaces the file in one step. */
	done: boolean;
}

export interface VfsWriteReply {
	/** Bytes the host has for the file once this slice landed. */
	received: number;
}

export interface VfsMkdirRequest {
	share: string;
	path: string;
}

export interface VfsRemoveRequest {
	share: string;
	path: string;
}

export interface VfsRenameRequest {
	share: string;
	from: string;
	to: string;
}

/** One folder the host shares. `id` is stable across renames of the label. */
export interface VfsShare {
	id: string;
	label: string;
	path: string;
}

export interface VfsSharesReply {
	shares: VfsShare[];
}

export interface VfsShareAddRequest {
	/** Absolute path on the host. */
	path: string;
	label: string;
}

export interface VfsShareAddReply {
	share: VfsShare;
}

export interface VfsShareRemoveRequest {
	id: string;
}

/** An external change the host noticed in a shared folder. */
export interface VfsChangedEvent {
	shareId: string;
	kind: 'created' | 'modified' | 'removed' | 'renamed';
	/** POSIX path relative to the share. */
	path: string;
}

/* ------------------------------------------------------------------------------------------------
 * anki
 * ---------------------------------------------------------------------------------------------- */

export interface AnkiStatusReply {
	/** The user's toggle. */
	enabled: boolean;
	/** Whether AnkiConnect answered the probe just now. */
	reachable: boolean;
	/** AnkiConnect API version, when it answered. */
	version: number | null;
	error?: string;
}

export interface AnkiSetEnabledRequest {
	enabled: boolean;
}

export interface AnkiInvokeRequest {
	action: string;
	params?: unknown;
	version?: number;
}

export interface AnkiInvokeReply {
	result: unknown;
}

/* ------------------------------------------------------------------------------------------------
 * ai
 * ---------------------------------------------------------------------------------------------- */

export type AiProvider = 'ollama' | 'openai';

export interface AiMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface AiStatusReply {
	provider: AiProvider;
	endpoint: string;
	model: string;
	/** True when a key is stored on the host. The key itself never leaves the host. */
	keySet: boolean;
	/** `sk-...1234`, all the client ever sees. */
	keyMasked: string | null;
	/** Whether the endpoint answered the last probe. */
	available: boolean;
	/** Model names the endpoint reported, when it reports them. */
	models: string[];
}

export interface AiConfigRequest {
	provider?: AiProvider;
	endpoint?: string;
	model?: string;
}

export interface AiSetKeyRequest {
	/** Write-only. The host stores it and answers with the masked form. */
	key: string;
}

export interface AiChatRequest {
	/** Client-chosen, echoed on every chunk of this stream. */
	streamId: string;
	messages: AiMessage[];
	model?: string;
	temperature?: number;
}

export interface AiCancelRequest {
	streamId: string;
}

export interface AiChunkEvent {
	streamId: string;
	delta: string;
}

export interface AiEndEvent {
	streamId: string;
	text: string;
}

export interface AiStreamErrorEvent {
	streamId: string;
	error: RpcErrorInfo;
}

/* ------------------------------------------------------------------------------------------------
 * status
 * ---------------------------------------------------------------------------------------------- */

export interface StatusInfoReply {
	hostName: string;
	hostVersion: string;
	protocol: number;
	uptimeMs: number;
	/** How many proven clients this daemon is holding right now. The clients themselves are private. */
	connectedClients: number;
	platform: string;
	shares: VfsShare[];
	ankiEnabled: boolean;
	ai: {
		provider: AiProvider;
		model: string;
		keySet: boolean;
	};
}

export interface StatusPingReply {
	/** Echoed straight back, so the client can measure a round trip. */
	t: number;
}

export interface StatusClientsEvent {
	connectedClients: number;
}

/* ------------------------------------------------------------------------------------------------
 * The typed surface
 * ---------------------------------------------------------------------------------------------- */

export interface RpcSpec {
	'auth:hello': { payload: AuthHelloPayload; reply: AuthHelloReply };
	'auth:prove': { payload: AuthProvePayload; reply: AuthOkPayload };
	'auth:pair': { payload: AuthPairPayload; reply: AuthOkPayload };

	'vfs:list': { payload: VfsListRequest; reply: VfsListReply };
	'vfs:stat': { payload: VfsStatRequest; reply: VfsStatReply };
	'vfs:read': { payload: VfsReadRequest; reply: VfsReadReply };
	'vfs:write': { payload: VfsWriteRequest; reply: VfsWriteReply };
	'vfs:mkdir': { payload: VfsMkdirRequest; reply: Record<string, never> };
	'vfs:remove': { payload: VfsRemoveRequest; reply: Record<string, never> };
	'vfs:rename': { payload: VfsRenameRequest; reply: Record<string, never> };
	'vfs:shares': { payload: Record<string, never>; reply: VfsSharesReply };
	'vfs:share-add': { payload: VfsShareAddRequest; reply: VfsShareAddReply };
	'vfs:share-remove': { payload: VfsShareRemoveRequest; reply: Record<string, never> };

	'anki:status': { payload: Record<string, never>; reply: AnkiStatusReply };
	'anki:set-enabled': { payload: AnkiSetEnabledRequest; reply: AnkiStatusReply };
	'anki:invoke': { payload: AnkiInvokeRequest; reply: AnkiInvokeReply };

	'ai:status': { payload: Record<string, never>; reply: AiStatusReply };
	'ai:config': { payload: AiConfigRequest; reply: AiStatusReply };
	'ai:set-key': { payload: AiSetKeyRequest; reply: AiStatusReply };
	'ai:clear-key': { payload: Record<string, never>; reply: AiStatusReply };
	'ai:chat': { payload: AiChatRequest; reply: Record<string, never> };
	'ai:cancel': { payload: AiCancelRequest; reply: Record<string, never> };

	'status:info': { payload: Record<string, never>; reply: StatusInfoReply };
	'status:ping': { payload: StatusPingReply; reply: StatusPingReply };
}

export type RpcAction = keyof RpcSpec;
export type RpcPayload<A extends RpcAction> = RpcSpec[A]['payload'];
export type RpcResult<A extends RpcAction> = RpcSpec[A]['reply'];

/** Events the host pushes once a session is ready. */
export interface RpcEvents {
	'vfs:changed': VfsChangedEvent;
	'vfs:shares': VfsSharesReply;
	'ai:chunk': AiChunkEvent;
	'ai:end': AiEndEvent;
	'ai:error': AiStreamErrorEvent;
	'status:clients': StatusClientsEvent;
}

export type RpcEventName = keyof RpcEvents;
export type RpcEventPayload<E extends RpcEventName> = RpcEvents[E];

export function splitAction(action: RpcAction): { subsystem: RpcSubsystem; name: string } {
	const [subsystem, name] = action.split(':') as [RpcSubsystem, string];
	return { subsystem, name };
}

/* ------------------------------------------------------------------------------------------------
 * Signaling
 *
 * Before there is a DataChannel there has to be an introduction. The daemon runs a small WebSocket
 * server; the client joins a room and the two swap an SDP offer, an answer and ICE candidates.
 * Nothing secret rides here. The DataChannel is encrypted by DTLS and every session still has to
 * pass the auth exchange above, so the signaling server can only ever carry introductions.
 * ---------------------------------------------------------------------------------------------- */

export type SignalMessage =
	| {
			t: 'join';
			/** `pair:<code>` for a first pairing, `host:<fingerprint>` for a returning client. */
			room: string;
			role: 'client';
			name?: string;
	  }
	| { t: 'joined'; room: string; host: { name: string; version: string; fingerprint: string } }
	| {
			t: 'signal';
			data:
				| { type: 'offer'; sdp: string }
				| { type: 'answer'; sdp: string }
				| { type: 'candidate'; candidate: { candidate: string; sdpMid?: string; sdpMLineIndex?: number } | null };
	  }
	| { t: 'error'; reason: string }
	| { t: 'ping' }
	| { t: 'pong' };

/** Just the payload of a `signal` frame — an offer, an answer, or one ICE candidate. */
export type SignalPayload = Extract<SignalMessage, { t: 'signal' }>['data'];

/** The room name a returning client joins. */
export function hostRoom(fingerprintHex: string): string {
	return `host:${fingerprintHex}`;
}

/** The room name a first-time pairing uses. */
export function pairRoom(code: string): string {
	return `pair:${code.replaceAll(/[\s-]/g, '').toUpperCase()}`;
}
