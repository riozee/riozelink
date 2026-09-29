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
import { isPhraseShaped, normalizePhrase } from './words.ts';

export const PROTOCOL_VERSION = 1;

/** Who a message is for. `auth` runs first; everything else answers once a session is proven. */
export type RpcSubsystem = 'auth' | 'vfs' | 'web' | 'anki' | 'ai' | 'status';

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

/**
 * How much of one page travels per message.
 *
 * The same 45 KiB as a file chunk, and for the same reason: a fetched page rides the same
 * DataChannel and has to fit the same 64 KiB message some stacks advertise. A page is read
 * in chunks exactly like a file is.
 */
export const WEB_CHUNK = VFS_CHUNK;

/* ------------------------------------------------------------------------------------------------
 * auth
 *
 * The client generates an ECDSA P-256 key pair (non-extractable private key, stored in the
 * browser). The host has one too. Hello proves the host, proof and pairing prove the client.
 * Everything is WebCrypto on both sides, so the signature formats match exactly.
 *
 * Pairing also has to prove that the person typing knows the code. That proof is an HMAC,
 * not a signature: the code is stretched with PBKDF2 first (see {@link derivePairingKey}), and
 * the code the host generated is never sent back over the wire in any form.
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
	/** Base64 HMAC of the host nonce, keyed by the code. See {@link pairProof}. */
	proof: string;
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

/* ------------------------------------------------------------------------------------------------
 * web
 *
 * A page the host fetched. The browser cannot frame most of the web, so the host asks for the page
 * with its own IP and its own request, tidies it into something that can be framed, and hands it
 * back. The body is read in chunks the way a file is, and each page lives in the session that asked
 * for it until four more are fetched.
 * ---------------------------------------------------------------------------------------------- */

export interface WebFetchRequest {
	/** A full `http:` or `https:` URL. Anything else is refused. */
	url: string;
}

export interface WebFetchReply {
	/** Handle for this page inside this session. Read the body with `web:read`. */
	id: string;
	/** Where the fetch actually ended, after redirects. */
	url: string;
	/** The page's own title, when it has one. */
	title: string | null;
	contentType: string;
	/** Whole body size, in bytes. */
	size: number;
	/** True when the page was cut off at the host's limit. */
	truncated: boolean;
}

export interface WebReadRequest {
	id: string;
	offset: number;
	length: number;
}

export interface WebReadReply {
	/** Base64 of this slice of the page. */
	data: string;
	size: number;
	/** True when this slice reaches the end. */
	done: boolean;
}

/**
 * Asks the host to look at a page's *headers* only, without carrying the page back. The browser
 * uses it to tell a page that loaded quickly apart from a page that was refused: a site that
 * sends `X-Frame-Options` or a `frame-ancestors` policy is the one case the proxy exists for.
 */
export interface WebProbeRequest {
	url: string;
}

export interface WebProbeReply {
	/** The header that would keep this page out of a frame, or null when nothing would. */
	framing: 'x-frame-options' | 'frame-ancestors' | null;
	/** The header's own value, for a log line the user can read. */
	detail: string | null;
	status: number;
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
	/** The user's toggle. Off means the gateway refuses to send anything. */
	enabled: boolean;
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
	enabled?: boolean;
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
		enabled: boolean;
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

	'web:fetch': { payload: WebFetchRequest; reply: WebFetchReply };
	'web:read': { payload: WebReadRequest; reply: WebReadReply };
	'web:probe': { payload: WebProbeRequest; reply: WebProbeReply };

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
	'anki:status': AnkiStatusReply;
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
 * Before there is a DataChannel there has to be an introduction. Both ends meet in a room on a
 * relay: one WebSocket endpoint that forwards every text frame it receives to the other clients in
 * the same room, verbatim, and says nothing of its own. It keeps no account of who is present, so
 * the two ends address each other by the `from` id they put on their own messages.
 *
 * The relay is one fixed host. It is not configurable and it is not shown anywhere, because a
 * meeting point is only as good as the machine it runs on and there is nothing a user could usefully
 * do with the address. Nothing secret rides here either: a room name is a derived value, every
 * payload is DTLS-encrypted once the DataChannel is up, and a session still has to pass the auth
 * exchange above before any request is answered.
 *
 * The message shape is the relay's recommended convention, and its rules shape the code: text
 * frames only, 64 KiB of UTF-8 per frame, no echo back to the sender, and no server-generated
 * traffic of any kind. Presence is the one thing the relay cannot provide, so `hello` and `bye`
 * exist for the ends to say it themselves.
 * ---------------------------------------------------------------------------------------------- */

/** The relay both ends meet on. Fixed on purpose, and deliberately not something to configure. */
export const SIGNAL_URL = 'wss://signal.rioze.dev';

/** The relay refuses a handshake that does not offer this, with a plain 404. */
export const SIGNAL_SUBPROTOCOL = 'usagi-una-prr-prr-yaha';

/** The relay's frame limit, in UTF-8 bytes. A larger frame closes the socket with 1009. */
export const SIGNAL_MAX_FRAME = 64 * 1024;

/** What one end says to the other. */
export type RelayMessageType = 'hello' | 'offer' | 'answer' | 'candidate' | 'bye';

/**
 * One message between two ends in a room.
 *
 * `from` is the sender's own id rather than anything the relay assigns, and it is how the other end
 * knows who it is talking to. `to` narrows a message to a single end, which matters when a room
 * happens to hold more than two.
 */
export interface RelayMessage {
	type: RelayMessageType;
	/** Echo of the room, so an end sitting in several rooms can check where a message came from. */
	room: string;
	/** The sender's own id, picked by the sender and checked by nobody. */
	from: string;
	/** Unix epoch milliseconds. */
	ts: number;
	/** When set, only this end should act on the message. */
	to?: string;
	/** `offer` and `answer`. */
	sdp?: string;
	/** `candidate`. A null candidate is the end-of-candidates marker. */
	candidate?: string | null;
	sdpMid?: string | null;
	sdpMLineIndex?: number | null;
	/** `hello`: the protocol revision, so two ends can notice they disagree. */
	protocol?: number;
}

/** What an end hands to its socket: the message body, without the fields the socket fills in. */
export type RelayOutgoing =
	| { type: 'hello'; to?: string; protocol: number }
	| { type: 'offer'; to?: string; sdp: string }
	| { type: 'answer'; to?: string; sdp: string }
	| {
			type: 'candidate';
			to?: string;
			candidate: string | null;
			sdpMid?: string | null;
			sdpMLineIndex?: number | null;
		}
	| { type: 'bye'; to?: string };

/**
 * A throwaway id for one end of one link.
 *
 * The relay never checks it, so it only has to be unlikely to collide with the other end's. The
 * prefix says which side made it, which is what a log line needs to be readable.
 */
export function makePeerId(prefix: 'rz-c' | 'rz-h'): string {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${prefix}-${hex}`;
}

/**
 * The socket URL for one room.
 *
 * `wss://<host>/ws?room=<room>` is the whole of it. A bare host is given the `wss://` scheme and a
 * trailing slash is dropped, because both are things a person types.
 */
export function signalSocketUrl(base: string, room: string): string {
	const trimmed = base.trim().replace(/\/+$/, '');
	const url = /^wss?:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`;
	return `${url}/ws?room=${encodeURIComponent(room)}`;
}

/**
 * True when a frame fits the relay's limit.
 *
 * Worth asking before sending: the relay answers an oversized frame by closing the socket with 1009,
 * which would take the whole room down over one bad message.
 */
export function fitsRelayFrame(text: string): boolean {
	return new TextEncoder().encode(text).byteLength <= SIGNAL_MAX_FRAME;
}

/* ------------------------------------------------------------------------------------------------
 * Words, rooms and the pairing proof
 *
 * One code does three jobs: a person reads it off the host's terminal, it names the room on the
 * relay, and it is the secret that proves the person was at that terminal. It is never sent
 * anywhere. Both sides stretch it twice, once into the room name and once into an HMAC key, so the
 * relay only ever sees a derived value and the host only ever sees the proof.
 * ---------------------------------------------------------------------------------------------- */

/** PBKDF2 rounds. Slow enough to make a code list painful to walk, fast enough to feel instant. */
export const PAIR_KDF_ITERATIONS = 100_000;

/** Keeps the key bound to this protocol version and this job. */
export const PAIR_KDF_SALT = 'riozelink:pair:v1';

declare const btoa: (data: string) => string;
declare const atob: (data: string) => string;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/**
 * The phrase helpers live in `words.ts`, beside the format they describe, and are re-exported here
 * because everything that derives a room or a proof needs them.
 *
 * They used to be copied into this file instead, and that copy is what broke pairing: it stripped
 * anything that was not a letter, so the moment the code grew a Crockford tail the daemon folded
 * `2r3q` into `r-q` and derived a different room than the browser did for the very same code. Two
 * spellings of one phrase is one spelling too many, so there is now only one.
 */
export { isPhraseShaped, normalizePhrase };

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The salt the room name is stretched with. Distinct from the proof's, so the two never mix. */
export const ROOM_KDF_SALT = 'riozelink:room:v1';

/**
 * The code, stretched to 256 bits.
 *
 * The room name is the one low-entropy secret this protocol publishes: the daemon writes it into the
 * socket URL, which is the part the relay reads. Deriving it with a
 * plain hash would let whoever reads that name test the whole code space offline at hash speed,
 * which is the difference between an afternoon and an afternoon that never ends. Stretching costs
 * the same 100,000 rounds the proof costs, once per connection, and that is affordable.
 */
async function deriveRoomKey(phrase: string): Promise<ArrayBuffer> {
	const material = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(normalizePhrase(phrase)),
		'PBKDF2',
		false,
		['deriveBits']
	);
	return crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: new TextEncoder().encode(ROOM_KDF_SALT),
			iterations: PAIR_KDF_ITERATIONS,
			hash: 'SHA-256'
		},
		material,
		256
	);
}

/**
 * The pairing room: a stretched form of the code, so the relay never learns the code and could not
 * walk the space if it kept a copy of this name either. Two ends can only meet there if they were
 * told the same code, and the room dies with the pairing window.
 */
export function pairRoom(phrase: string): Promise<string> {
	return deriveRoomKey(phrase).then(
		(bits) =>
			`rz-pair-${[...new Uint8Array(bits)]
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('')
				.slice(0, 24)}`
	);
}

/**
 * The room two already-paired ends meet in, named after both fingerprints. Nobody else can compute
 * it, which is why a reconnect needs no code, no address, and no attention from the user.
 */
export function linkRoom(hostFingerprintHex: string, clientFingerprintHex: string): Promise<string> {
	return sha256Hex(
		`riozelink:link:v1:${hostFingerprintHex.toLowerCase()}:${clientFingerprintHex.toLowerCase()}`
	).then((hex) => `rz-link-${hex.slice(0, 24)}`);
}

/**
 * PBKDF2(phrase) → a non-extractable HMAC key. The host derives the same key from the phrase it
 * generated; neither side ever compares phrases, only proofs.
 */
export async function derivePairingKey(phrase: string): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(normalizePhrase(phrase)),
		'PBKDF2',
		false,
		['deriveKey']
	);
	return crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: new TextEncoder().encode(PAIR_KDF_SALT),
			iterations: PAIR_KDF_ITERATIONS,
			hash: 'SHA-256'
		},
		material,
		{ name: 'HMAC', hash: 'SHA-256', length: 256 },
		false,
		['sign']
	);
}

/** Base64 HMAC of the host nonce — one fresh proof per handshake, derived from the words. */
export async function pairProof(phrase: string, hostNonce: string): Promise<string> {
	const key = await derivePairingKey(phrase);
	const signature = await crypto.subtle.sign('HMAC', key, base64ToBytes(hostNonce));
	return bytesToBase64(new Uint8Array(signature));
}
