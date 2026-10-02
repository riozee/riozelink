/**
 * The browsing tunnel: HTTP carried over the link.
 *
 * A browser in riozeOS can run a real rewriting proxy (Ultraviolet), but the service worker that
 * proxy runs on cannot open a WebRTC connection — a service worker has no `RTCPeerConnection`.
 * So the service worker hands every request it handles to the page, the page forwards it over the
 * DataChannel, and this file is what is waiting on the other end: one native `fetch` per stream,
 * the response sliced into messages small enough for the channel, and nothing remembered between
 * requests.
 *
 * Four messages make one exchange. `open` names the request and is answered when the response
 * headers arrive; `body` supplies the request's bytes when there are any; `ack` is the client
 * saying it has taken delivery of bytes already sent; `abort` says the page walked away. The
 * response streams back as `chunk` events and ends with `end` — or with `error`, the only way a
 * failure after the headers can be reported.
 *
 * Three deliberate decisions, each with a reason worth knowing:
 *
 *   - **No cookie jar.** Cookies ride in the request headers the client sends and come back in
 *     `set-cookie` untouched. The client's proxy keeps the jar; a host-side copy would be a
 *     second truth about who the user is, and would grow forever on a machine that is supposed
 *     to be a pipe.
 *   - **No redirect following.** `redirect: 'manual'` hands the 3xx and its `location` back,
 *     because the client's proxy follows the chain itself — hop by hop, through this same
 *     tunnel, which is what keeps a redirect's destination a rewritten page like any other.
 *   - **The body is decoded here.** This runtime decompresses responses transparently, so the
 *     encoding a client asks for is pinned to the set it can decode, and `content-encoding` and
 *     `content-length` are dropped from what goes back — passing them on would make the client
 *     try to gunzip bytes that were already decoded, which is the kind of bug that reads as
 *     "the computer is broken" a long way from its cause.
 *
 * `TUNNEL_WINDOW` is a flow-control window rather than a size limit: once that many bytes are
 * unacknowledged the host simply stops reading the remote body, so a page that stops consuming
 * slows the host down instead of filling a buffer nobody is watching.
 */
import { HostError, requireNumber, requireString, toErrorInfo } from './errors.ts';
import {
	TUNNEL_CHUNK,
	TUNNEL_MAX_BODY,
	TUNNEL_MAX_STREAMS,
	TUNNEL_WINDOW,
	type RpcErrorInfo,
	type TunnelHeadReply
} from './protocol.ts';
import { fromBase64, toBase64, truncate } from './util.ts';

/**
 * How long the host waits for a request to reach its response headers. The clock starts when the
 * request is opened, so it covers the client's own body upload as well — the fetch cannot begin
 * before the body has arrived, and a stalled half of it should not hold a slot forever.
 */
const TUNNEL_HEADER_TIMEOUT_MS = 30_000;

/** The methods the tunnel passes through. Anything else is a protocol error, not a proxy. */
const TUNNEL_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * Request headers the host manages itself. `host` and `content-length` are recomputed by the
 * fetch, the hop-by-hop set describes a connection that ends here, and `accept-encoding` is
 * pinned by `prepareRequestHeaders` so its answer always matches what this runtime decodes.
 */
const REQUEST_HEADER_DROP = new Set([
	'host',
	'content-length',
	'connection',
	'keep-alive',
	'transfer-encoding',
	'upgrade',
	'te',
	'trailer',
	'expect',
	'proxy-authorization',
	'proxy-connection',
	'accept-encoding'
]);

/**
 * Response headers the client must never see. The framing rules are the reason the tunnel exists
 * at all, so they are stripped here as well as inside the proxy — belt and braces, and it keeps
 * a response frameable even if it is read by something else. The hop-by-hop set describes a
 * connection that no longer exists on the client's side, and the two content headers would lie:
 * the body is decoded and re-sliced here, so neither the original length nor its encoding is
 * true about what travels back.
 */
const RESPONSE_HEADER_DROP = new Set([
	'x-frame-options',
	'content-security-policy',
	'content-security-policy-report-only',
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-encoding',
	'content-length'
]);

/**
 * What one session's tunnel needs from its session: a way to push events and a way to be honest
 * in the log. Failures are logged; successes are not, because one page load is dozens of
 * requests and a note about each would drown the lines that matter.
 */
export interface TunnelHost {
	emit(action: 'chunk' | 'end' | 'error', payload: unknown): void;
	log(level: 'info' | 'warn' | 'error', message: string): void;
}

interface TunnelStream {
	requestId: string;
	/** For logs and for the timeout message; already truncated when it gets there. */
	url: string;
	host: string;
	controller: AbortController;
	/** `body` → `fetching` → `streaming` → `done`. `done` means finished or abandoned. */
	phase: 'body' | 'fetching' | 'streaming' | 'done';
	bodyExpected: number;
	bodyReceived: number;
	bodyParts: Uint8Array<ArrayBuffer>[];
	/** Resolves when the whole request body has arrived. */
	bodyReady: Promise<void>;
	markBodyReady: (() => void) | null;
	sent: number;
	acked: number;
	flowWaiters: Array<() => void>;
	timer: ReturnType<typeof setTimeout> | null;
}

export class TunnelSession {
	private readonly streams = new Map<string, TunnelStream>();

	constructor(private readonly host: TunnelHost) {}

	/** Everything the session was carrying stops here. Used when the link closes. */
	dispose(): void {
		for (const stream of [...this.streams.values()]) {
			this.finish(stream);
			stream.controller.abort();
		}
		this.streams.clear();
	}

	/**
	 * Registers one exchange and answers with its response headers. The promise waits while the
	 * client uploads the request body, then for the fetch itself; the response's bytes follow as
	 * `chunk` events, and their absence is announced with `error`.
	 */
	async open(raw: Record<string, unknown>): Promise<TunnelHeadReply> {
		const requestId = requireString(raw.requestId, 'requestId');
		const method = requireString(raw.method, 'method').toUpperCase();
		const url = requireString(raw.url, 'url');
		const bodyLength = Math.floor(requireNumber(raw.bodyLength, 'bodyLength'));

		if (!TUNNEL_METHODS.has(method)) {
			throw new HostError(`the tunnel does not carry ${method}`, 'invalid');
		}
		if (bodyLength < 0 || bodyLength > TUNNEL_MAX_BODY) {
			throw new HostError(
				`a request body may be at most ${Math.round(TUNNEL_MAX_BODY / (1024 * 1024))} MiB`,
				'invalid'
			);
		}
		if (this.streams.has(requestId)) {
			throw new HostError('that request id is already in flight', 'invalid');
		}
		if (this.streams.size >= TUNNEL_MAX_STREAMS) {
			throw new HostError(
				'the computer is already carrying as many requests as it will',
				'busy'
			);
		}

		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new HostError(`that is not a URL: ${truncate(url, 120)}`, 'invalid');
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new HostError(`only http and https travel the tunnel, not ${parsed.protocol}`, 'invalid');
		}

		const stream: TunnelStream = {
			requestId,
			url,
			host: parsed.host,
			controller: new AbortController(),
			phase: bodyLength > 0 ? 'body' : 'fetching',
			bodyExpected: bodyLength,
			bodyReceived: 0,
			bodyParts: [],
			bodyReady: Promise.resolve(),
			markBodyReady: null,
			sent: 0,
			acked: 0,
			flowWaiters: [],
			timer: null
		};
		if (bodyLength > 0) {
			stream.bodyReady = new Promise<void>((resolve) => {
				stream.markBodyReady = resolve;
			});
		}
		this.streams.set(requestId, stream);

		// The clock covers the whole road to the response headers: the body upload, then the
		// fetch. It is cleared the moment the headers are in hand; a stream that has started
		// talking is the client's to stop, through `abort`.
		let timedOut = false;
		const timeout = new Promise<never>((_resolve, reject) => {
			stream.timer = setTimeout(() => {
				if (stream.phase === 'done') return;
				timedOut = true;
				this.finish(stream);
				stream.controller.abort();
				const waitingOnBody = stream.bodyReceived < stream.bodyExpected;
				reject(
					new HostError(
						waitingOnBody
							? 'the client did not finish sending the request body in time'
							: `${stream.host} took longer than ${Math.round(TUNNEL_HEADER_TIMEOUT_MS / 1000)}s to answer`,
						'offline'
					)
				);
			}, TUNNEL_HEADER_TIMEOUT_MS);
		});

		try {
			await Promise.race([stream.bodyReady, timeout]);
		} catch (error) {
			this.finish(stream);
			throw error;
		}
		if (stream.phase === 'done') {
			// Aborted while the body was arriving. The abort already answered the client; this
			// reply is only reaching a message nobody is waiting on any more.
			throw new HostError('the request was cancelled', 'invalid');
		}

		let body: Uint8Array<ArrayBuffer> | undefined;
		if (bodyLength > 0) {
			body = concatenate(stream.bodyParts, bodyLength);
			stream.bodyParts = [];
		}

		let response: Response;
		try {
			response = await fetch(parsed, {
				method,
				headers: prepareRequestHeaders(raw.headers),
				body: method === 'GET' || method === 'HEAD' ? undefined : body,
				redirect: 'manual',
				signal: stream.controller.signal
			});
		} catch (error) {
			this.finish(stream);
			if (timedOut || stream.controller.signal.aborted) {
				throw new HostError('the request was cancelled', 'invalid');
			}
			const message = (error as Error)?.message ?? 'the fetch failed';
			this.host.log(
				'warn',
				`tunnel: ${truncate(url, 100)} could not be reached (${truncate(message, 100)})`
			);
			throw new HostError(`${stream.host} could not be reached (${message})`, 'offline');
		}
		if (abandoned(stream)) {
			throw new HostError('the request was cancelled', 'invalid');
		}

		if (stream.timer) {
			clearTimeout(stream.timer);
			stream.timer = null;
		}
		stream.phase = 'streaming';
		const head: TunnelHeadReply = {
			status: response.status,
			statusText: response.statusText,
			headers: prepareResponseHeaders(response.headers)
		};
		void this.pump(stream, response);
		return head;
	}

	/** One slice of a request body. The exchange starts once the last slice has arrived. */
	body(raw: Record<string, unknown>): Record<string, never> {
		const requestId = requireString(raw.requestId, 'requestId');
		const stream = this.streams.get(requestId);
		if (!stream) throw new HostError('that request is no longer in flight', 'not-found');
		if (stream.phase !== 'body') {
			throw new HostError('that request does not take a body, or already has it', 'invalid');
		}
		const data = typeof raw.data === 'string' ? raw.data : '';
		const done = raw.done === true;
		const bytes = data ? fromBase64(data) : new Uint8Array(0);
		if (stream.bodyReceived + bytes.byteLength > stream.bodyExpected) {
			this.finish(stream);
			stream.controller.abort();
			throw new HostError('the request body is bigger than it said it would be', 'invalid');
		}
		if (bytes.byteLength > 0) {
			stream.bodyParts.push(bytes);
			stream.bodyReceived += bytes.byteLength;
		}
		if (done) {
			if (stream.bodyReceived !== stream.bodyExpected) {
				this.finish(stream);
				stream.controller.abort();
				throw new HostError('the request body ended short', 'invalid');
			}
			stream.markBodyReady?.();
			stream.markBodyReady = null;
		}
		return {};
	}

	/** The page took delivery of some bytes. That is what reopens the flow-control window. */
	ack(raw: Record<string, unknown>): Record<string, never> {
		const requestId = requireString(raw.requestId, 'requestId');
		const bytes = Math.max(0, Math.floor(requireNumber(raw.bytes, 'bytes')));
		const stream = this.streams.get(requestId);
		if (!stream) return {};
		stream.acked = Math.min(stream.sent, stream.acked + bytes);
		for (const wake of stream.flowWaiters.splice(0)) wake();
		return {};
	}

	/** The page walked away. Nothing is emitted back: silence is the whole reply. */
	abort(raw: Record<string, unknown>): Record<string, never> {
		const requestId = requireString(raw.requestId, 'requestId');
		const stream = this.streams.get(requestId);
		if (stream) {
			this.finish(stream);
			stream.controller.abort();
		}
		return {};
	}

	/* ------------------------------------------------------------------ internals ------- */

	/**
	 * Reads the response to its end, slicing as it goes. The reader is paused whenever the
	 * window is full, so the remote server's own TCP backpressure does the rest.
	 */
	private async pump(stream: TunnelStream, response: Response): Promise<void> {
		let failure: RpcErrorInfo | null = null;
		try {
			const reader = response.body?.getReader();
			if (reader) {
				let seq = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!value || value.byteLength === 0) continue;
					for (let at = 0; at < value.byteLength; at += TUNNEL_CHUNK) {
						const slice = value.subarray(at, Math.min(at + TUNNEL_CHUNK, value.byteLength));
						await this.waitForRoom(stream, slice.byteLength);
						if (stream.phase === 'done') return;
						this.host.emit('chunk', {
							requestId: stream.requestId,
							seq,
							data: toBase64(slice)
						});
						seq += 1;
						stream.sent += slice.byteLength;
					}
				}
			}
		} catch (error) {
			// An abort is the client's own doing and is answered with silence; anything else is a
			// real mid-stream failure and the only way the client can hear about it.
			if (stream.phase !== 'done' && !stream.controller.signal.aborted) {
				failure = toErrorInfo(error);
				this.host.log(
					'warn',
					`tunnel: ${truncate(stream.url, 100)} failed mid-stream (${truncate(failure.message, 100)})`
				);
			}
		}
		const aborted = stream.phase === 'done';
		this.finish(stream);
		if (aborted) return;
		if (failure) this.host.emit('error', { requestId: stream.requestId, error: failure });
		else this.host.emit('end', { requestId: stream.requestId });
	}

	private async waitForRoom(stream: TunnelStream, bytes: number): Promise<void> {
		while (stream.phase !== 'done' && stream.sent + bytes - stream.acked > TUNNEL_WINDOW) {
			await new Promise<void>((resolve) => {
				stream.flowWaiters.push(resolve);
			});
		}
	}

	private settle(stream: TunnelStream): void {
		stream.phase = 'done';
		for (const wake of stream.flowWaiters.splice(0)) wake();
	}

	private finish(stream: TunnelStream): void {
		this.settle(stream);
		if (stream.timer) {
			clearTimeout(stream.timer);
			stream.timer = null;
		}
		this.streams.delete(stream.requestId);
	}
}

/**
 * The request as the fetch will send it. Headers travel as the client wrote them — that is the
 * point of carrying them — apart from the ones this side owns. `accept-encoding` is pinned to
 * exactly the encodings this runtime decodes, because the answer is what its transparent
 * decompression depends on; dropping the client's own list is also what keeps an encoding it
 * asked for and this side cannot read from ever arriving.
 */
function prepareRequestHeaders(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (raw && typeof raw === 'object') {
		for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof value !== 'string' && !Array.isArray(value)) continue;
			const key = name.toLowerCase();
			if (!key || REQUEST_HEADER_DROP.has(key)) continue;
			out[key] = Array.isArray(value) ? value.join(', ') : value;
		}
	}
	out['accept-encoding'] = 'gzip, deflate, br';
	return out;
}

/**
 * The response as the client will rebuild it. `set-cookie` is the one header that has to keep
 * its list shape — a browser cannot split a combined `Set-Cookie` back apart, because expiry
 * dates carry commas — so it is read with `getSetCookie` and shipped as an array.
 */
function prepareResponseHeaders(headers: Headers): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [name, value] of headers) {
		const key = name.toLowerCase();
		if (RESPONSE_HEADER_DROP.has(key) || key === 'set-cookie') continue;
		out[key] = value;
	}
	const cookies = readSetCookies(headers);
	if (cookies.length > 0) out['set-cookie'] = cookies;
	return out;
}

function readSetCookies(headers: Headers): string[] {
	const withList = headers as Headers & { getSetCookie?: () => string[] };
	if (typeof withList.getSetCookie === 'function') return withList.getSetCookie();
	const single = headers.get('set-cookie');
	return single ? [single] : [];
}

function concatenate(parts: Uint8Array<ArrayBuffer>[], length: number): Uint8Array<ArrayBuffer> {
	const all = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		all.set(part, at);
		at += part.byteLength;
	}
	return all;
}

/** True once the stream is finished or abandoned. A function so narrowing cannot hide a read. */
function abandoned(stream: TunnelStream): boolean {
	return stream.phase === 'done';
}
