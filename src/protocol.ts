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
 *
 * Pairing also has to prove that the person typing knows the four words. That proof is an HMAC,
 * not a signature: the phrase is stretched with PBKDF2 first (see {@link derivePairingKey}), and
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

/** A first-time client pairs with the phrase the host prints. */
export interface AuthPairPayload {
	/** Base64 HMAC of the host nonce, keyed by the phrase. See {@link pairProof}. */
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
	/** The signaling server the host is parked on, so the client can say where the meeting point was. */
	signal: string;
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
 * Before there is a DataChannel there has to be an introduction. Both ends speak the PeerServer
 * protocol, the signaling server the `peerjs` library uses: every peer dials out with an id, the
 * server remembers who is where, and OFFER, ANSWER and CANDIDATE frames are forwarded to the id
 * they are addressed to. Nothing secret rides here. An id is a hash, the DataChannel is encrypted
 * by DTLS, and every session still has to pass the auth exchange above.
 *
 * The default is the public PeerServer cloud. Running your own is one command (`npx peerjs`) and a
 * different URL passed to `--signal`, because it is the same protocol. No TURN server is involved
 * anywhere; see the README for what that costs.
 *
 * The payload shape below is not our invention. It is what the peerjs library puts on a data
 * connection's offer, and the public cloud inspects it: a socket that sends anything else is closed
 * on the spot. `sdp` is a whole description object, `type` says `data`, and an offer carries the
 * connection's label and serialization. Speaking the library's dialect is the price of using a
 * server we do not run, and a server we do run is happy with the same frames.
 * ---------------------------------------------------------------------------------------------- */

/** The public PeerServer cloud, reached the way the peerjs library reaches it. */
export const DEFAULT_SIGNAL_URL = 'wss://0.peerjs.com/peerjs';

/** PeerServer's default key. The cloud expects this one. */
export const SIGNAL_KEY = 'peerjs';

/** Sent as `version`. The server only uses it to warn about mismatches. */
export const SIGNAL_VERSION = '1.5.5';

/** Everything the signaling server says, and everything we say to it. */
export type SignalMessageType =
	| 'OPEN'
	| 'HEARTBEAT'
	| 'OFFER'
	| 'ANSWER'
	| 'CANDIDATE'
	| 'LEAVE'
	| 'EXPIRE'
	| 'ID-TAKEN'
	| 'ERROR'
	| 'INVALID-KEY';

export interface SignalMessage {
	type: SignalMessageType;
	/** Who sent it. The server fills this in on everything it forwards. */
	src?: string;
	/** Who it is for. Both ends set this on OFFER, ANSWER, CANDIDATE and LEAVE. */
	dst?: string;
	payload?: SignalOffer | SignalCandidate | { msg?: string } | null;
}

/** What rides inside an OFFER or an ANSWER, in the shape the peerjs library uses. */
export interface SignalOffer {
	sdp: { type: 'offer' | 'answer'; sdp: string };
	/** The connection kind. RiozeLink only ever opens data channels. */
	type: 'data';
	/** Filled in by the sender, to tell one attempt from the next inside one link. */
	connectionId?: string;
	label?: string;
	reliable?: boolean;
	serialization?: 'binary';
}

/** What rides inside a CANDIDATE. `candidate: null` means gathering is done. */
export interface SignalCandidate {
	candidate: {
		candidate: string;
		sdpMid?: string;
		sdpMLineIndex?: number;
		usernameFragment?: string | null;
	} | null;
	type: 'data';
	connectionId?: string;
}

/** What the rest of the daemon cares about: descriptions and candidates, nothing else. */
export type SignalPayload = SignalOffer | SignalCandidate;

/**
 * Tells a description from a candidate. The envelope's own type does the real work (`OFFER`,
 * `ANSWER`, `CANDIDATE`), and this is for the payload-only paths.
 */
export function isOfferPayload(payload: SignalPayload): payload is SignalOffer {
	return 'sdp' in payload;
}

/**
 * An offer, with every field the library sends on a data connection. The cloud checks for them, so
 * they are filled in here rather than remembered at each call site.
 */
export function offerPayload(sdp: string, connectionId?: string): SignalOffer {
	return {
		sdp: { type: 'offer', sdp },
		type: 'data',
		connectionId,
		label: 'rioze',
		reliable: true,
		serialization: 'binary'
	};
}

/** The answer: the library sends these three fields, and the cloud accepts that. */
export function answerPayload(sdp: string, connectionId?: string): SignalOffer {
	return { sdp: { type: 'answer', sdp }, type: 'data', connectionId };
}

/** A gathered candidate. Gathering's end is not announced: the library never sends a null one. */
export function candidatePayload(
	candidate: NonNullable<SignalCandidate['candidate']>,
	connectionId?: string
): SignalCandidate {
	return { candidate, type: 'data', connectionId };
}

/** A throwaway id for the browser's side of one link. Valid on any PeerServer. */
export function makeSignalId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `rz-c-${hex}`;
}

/** 12 hex characters, to tell one link's frames from another's inside one socket. */
export function makeConnectionId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The socket URL for one id.
 *
 * `wss://0.peerjs.com/peerjs?key=peerjs&id=…&token=…&version=…` is the shape the peerjs library
 * builds, and every PeerServer, cloud or self-hosted, answers to it. A bare host gets the
 * default `/peerjs` path appended, because that is what surprises people the first time.
 */
export function signalSocketUrl(base: string, id: string, token: string): string {
	let url = base.trim().replace(/\/+$/, '');
	if (!/^wss?:\/\//i.test(url)) url = `wss://${url}`;
	try {
		if (new URL(url).pathname === '/') url = `${url}/peerjs`;
	} catch {
		// Not a URL at all. Let the socket fail with its own message.
	}
	return `${url}?key=${SIGNAL_KEY}&id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}&version=${SIGNAL_VERSION}`;
}

/* ------------------------------------------------------------------------------------------------
 * Words, rooms and the pairing proof
 *
 * One phrase does three jobs: a person reads it off the host's terminal, it names the room on the
 * relay, and it is the secret that proves the person was at that terminal. It is never sent
 * anywhere. Both sides hash it into a room name and stretch it into an HMAC key, so the relay
 * only ever sees the hash and the host only ever sees the proof.
 * ---------------------------------------------------------------------------------------------- */

/** PBKDF2 rounds. Slow enough to make a phrase list painful to walk, fast enough to feel instant. */
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

/** The one spelling of a phrase both ends agree on: lowercase words, single dashes. */
export function normalizePhrase(input: string): string {
	return input
		.toLowerCase()
		.replaceAll(/[^a-z]+/g, '-')
		.replaceAll(/^-+|-+$/g, '');
}

/** Three to six words. Shorter is a typo, longer is a paste accident. */
export function isPhraseShaped(phrase: string): boolean {
	const normalized = normalizePhrase(phrase);
	if (!normalized) return false;
	const words = normalized.split('-');
	return words.length >= 3 && words.length <= 6;
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The pairing id: a hash of the phrase, so the signaling server never learns the words. Two ends can
 * only meet here if they were told the same phrase, and the phrase dies with the pairing window.
 */
export function pairId(phrase: string): Promise<string> {
	return sha256Hex(`riozelink:pair:v1:${normalizePhrase(phrase)}`).then(
		(hex) => `rz-pair-${hex.slice(0, 24)}`
	);
}

/**
 * The id two already-paired ends meet under, named after both fingerprints. Nobody else can compute
 * it, which is why a reconnect needs no phrase, no address, and no attention from the user.
 */
export function linkId(hostFingerprintHex: string, clientFingerprintHex: string): Promise<string> {
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
