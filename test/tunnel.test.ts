/**
 * The browsing tunnel, end to end over the real link.
 *
 * A real daemon, a real relay, a real DataChannel — the same road the browser app takes. What is
 * checked here is the part the browser will depend on: the master switch gates everything, a
 * request's bytes travel whole in both directions, framing rules never reach the client, and a
 * response that arrives faster than the client consumes it slows the host down instead of
 * filling a buffer.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RiozeLinkHost } from '../src/host.ts';
import {
	pairRoom,
	TUNNEL_CHUNK,
	TUNNEL_MAX_STREAMS,
	TUNNEL_WINDOW,
	type StatusInfoReply,
	type TunnelChunkEvent,
	type TunnelEndEvent,
	type TunnelErrorEvent,
	type TunnelHeadReply
} from '../src/protocol.ts';
import { fromBase64, toBase64 } from '../src/util.ts';
import { startTestSignal, TestClient } from './support.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

let root: string;
let host: RiozeLinkHost;
let signal: { url: string; close(): Promise<void> };
let client: TestClient;
let web: { url: string; stop(): void };
let seq = 0;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'riozelink-tunnel-'));
	signal = await startTestSignal();
	host = await RiozeLinkHost.create({
		configDir: path.join(root, 'config'),
		signal: signal.url
	});
	await host.start();
	const code = host.pairingCode();
	if (!code) throw new Error('no pairing code is live');
	client = await TestClient.connect(signal.url, await pairRoom(code), { name: 'Tunnel Test' });
	await client.pair(code);
	web = startWebServer();
});

afterAll(async () => {
	client?.close();
	web?.stop();
	await host.stop('the test finished');
	await signal.close();
	await rm(root, { recursive: true, force: true });
});

/** The little origin the tunnel fetches from. Every route is a different thing to check. */
function startWebServer(): { url: string; stop(): void } {
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === '/hello') {
				return new Response('hello from the tunnel', {
					headers: { 'content-type': 'text/plain', 'x-tunnel': 'yes' }
				});
			}
			if (url.pathname === '/echo') {
				const body = Buffer.from(await request.arrayBuffer()).toString('utf8');
				return Response.json({
					method: request.method,
					body,
					cookie: request.headers.get('cookie')
				});
			}
			if (url.pathname === '/redirect') {
				return new Response(null, { status: 302, headers: { location: '/hello' } });
			}
			if (url.pathname === '/framed') {
				const headers = new Headers({
					'x-frame-options': 'DENY',
					'content-security-policy': "frame-ancestors 'none'",
					'content-type': 'text/html'
				});
				headers.append('set-cookie', 'a=1; Path=/; HttpOnly');
				headers.append('set-cookie', 'b=2; Path=/');
				return new Response('<p>framed</p>', { headers });
			}
			if (url.pathname === '/gzip') {
				const body = Bun.gzipSync(new TextEncoder().encode('decoded on the way through'));
				return new Response(body, {
					headers: { 'content-encoding': 'gzip', 'content-type': 'text/plain' }
				});
			}
			if (url.pathname === '/big') {
				const size = 2 * 1024 * 1024;
				const bytes = new Uint8Array(size);
				for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
				return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
			}
			if (url.pathname === '/slow') {
				const encoder = new TextEncoder();
				let timer: ReturnType<typeof setInterval> | null = null;
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						let tick = 0;
						timer = setInterval(() => {
							if (tick >= 5) {
								if (timer) clearInterval(timer);
								try {
									controller.close();
								} catch {
									// The client walked away.
								}
								return;
							}
							try {
								controller.enqueue(encoder.encode(`tick ${tick}\n`));
							} catch {
								if (timer) clearInterval(timer);
							}
							tick += 1;
						}, 60);
					},
					cancel() {
						if (timer) clearInterval(timer);
					}
				});
				return new Response(stream, { headers: { 'content-type': 'text/plain' } });
			}
			if (url.pathname === '/hang') {
				return new Promise<Response>(() => {
					// Holds the connection open until the client's abort closes it.
				});
			}
			return new Response('not found', { status: 404 });
		}
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}

function eventsFor(requestId: string): {
	chunks: TunnelChunkEvent[];
	end: TunnelEndEvent | null;
	error: TunnelErrorEvent | null;
} {
	const mine = client.events.filter(
		(event) =>
			event.subsystem === 'tunnel' &&
			(event.payload as { requestId?: string }).requestId === requestId
	);
	const chunks = mine
		.filter((event) => event.action === 'chunk')
		.map((event) => event.payload as TunnelChunkEvent)
		.sort((a, b) => a.seq - b.seq);
	const end = (mine.find((event) => event.action === 'end')?.payload as TunnelEndEvent) ?? null;
	const error =
		(mine.find((event) => event.action === 'error')?.payload as TunnelErrorEvent) ?? null;
	return { chunks, end, error };
}

function assemble(chunks: TunnelChunkEvent[]): Uint8Array {
	const parts = chunks.map((chunk) => fromBase64(chunk.data));
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const all = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		all.set(part, at);
		at += part.byteLength;
	}
	return all;
}

interface ExchangeOptions {
	method?: string;
	headers?: Record<string, string | string[]>;
	body?: Uint8Array;
}

/**
 * Opens one exchange the way the browser will: the `open` message first, the body slices right
 * behind it, and the reply awaited afterwards — the host is the one that waits for the body.
 */
function openExchange(url: string, options: ExchangeOptions = {}): {
	requestId: string;
	head: Promise<TunnelHeadReply>;
} {
	const requestId = `req-${++seq}`;
	const body = options.body;
	const head = client.call('tunnel', 'open', {
		requestId,
		method: options.method ?? 'GET',
		url,
		headers: options.headers ?? {},
		bodyLength: body?.byteLength ?? 0
	}) as Promise<TunnelHeadReply>;
	if (body && body.byteLength > 0) {
		const slices = Math.max(1, Math.ceil(body.byteLength / TUNNEL_CHUNK));
		for (let index = 0; index < slices; index += 1) {
			const part = body.subarray(
				index * TUNNEL_CHUNK,
				Math.min((index + 1) * TUNNEL_CHUNK, body.byteLength)
			);
			void client
				.call('tunnel', 'body', {
					requestId,
					data: toBase64(part),
					done: index === slices - 1
				})
				.catch(() => undefined);
		}
	}
	return { requestId, head };
}

async function readBody(requestId: string): Promise<{ bytes: Uint8Array; error: TunnelErrorEvent | null }> {
	await waitFor(
		() => eventsFor(requestId).end !== null || eventsFor(requestId).error !== null,
		`stream ${requestId} to finish`
	);
	const state = eventsFor(requestId);
	return { bytes: assemble(state.chunks), error: state.error };
}

test('the master switch gates every request, and its change is broadcast', async () => {
	const before = (await client.call('status', 'info')) as StatusInfoReply;
	expect(before.tunnelEnabled).toBe(false);

	const denied = await client.expectFailure('tunnel', 'open', {
		requestId: 'gate-denied',
		method: 'GET',
		url: `${web.url}/hello`,
		headers: {},
		bodyLength: 0
	});
	expect(denied.code).toBe('denied');

	const reply = (await client.call('tunnel', 'set-enabled', { enabled: true })) as {
		enabled: boolean;
	};
	expect(reply.enabled).toBe(true);
	await waitFor(
		() =>
			client.events.some(
				(event) =>
					event.subsystem === 'tunnel' &&
					event.action === 'status' &&
					(event.payload as { enabled: boolean }).enabled === true
			),
		'the tunnel status broadcast'
	);
	const after = (await client.call('status', 'info')) as StatusInfoReply;
	expect(after.tunnelEnabled).toBe(true);
});

test('a GET comes back whole, headers included', async () => {
	const { requestId, head } = openExchange(`${web.url}/hello`);
	const reply = await head;
	expect(reply.status).toBe(200);
	expect(reply.headers['x-tunnel']).toBe('yes');
	const { bytes, error } = await readBody(requestId);
	expect(error).toBeNull();
	expect(new TextDecoder().decode(bytes)).toBe('hello from the tunnel');
});

test('a POST carries its body and its cookies', async () => {
	const body = new TextEncoder().encode('written over the tunnel');
	const { requestId, head } = openExchange(`${web.url}/echo`, {
		method: 'POST',
		body,
		headers: { cookie: 'session=abc', 'content-type': 'text/plain' }
	});
	const reply = await head;
	expect(reply.status).toBe(200);
	const { bytes } = await readBody(requestId);
	const seen = JSON.parse(new TextDecoder().decode(bytes)) as {
		method: string;
		body: string;
		cookie: string;
	};
	expect(seen.method).toBe('POST');
	expect(seen.body).toBe('written over the tunnel');
	expect(seen.cookie).toBe('session=abc');
});

test('a redirect is handed back with its location, not followed', async () => {
	const { requestId, head } = openExchange(`${web.url}/redirect`);
	const reply = await head;
	expect(reply.status).toBe(302);
	expect(reply.headers.location).toBe('/hello');
	const { error } = await readBody(requestId);
	expect(error).toBeNull();
});

test('framing rules are stripped and every cookie keeps its own header', async () => {
	const { requestId, head } = openExchange(`${web.url}/framed`);
	const reply = await head;
	expect(reply.headers['x-frame-options']).toBeUndefined();
	expect(reply.headers['content-security-policy']).toBeUndefined();
	expect(Array.isArray(reply.headers['set-cookie'])).toBe(true);
	expect((reply.headers['set-cookie'] as string[]).length).toBe(2);
	await readBody(requestId);
});

test('a compressed body arrives decoded, with the lying headers dropped', async () => {
	const { requestId, head } = openExchange(`${web.url}/gzip`);
	const reply = await head;
	expect(reply.headers['content-encoding']).toBeUndefined();
	expect(reply.headers['content-length']).toBeUndefined();
	const { bytes, error } = await readBody(requestId);
	expect(error).toBeNull();
	expect(new TextDecoder().decode(bytes)).toBe('decoded on the way through');
});

test('the window stops the host from outrunning a client that is not acknowledging', async () => {
	const { requestId, head } = openExchange(`${web.url}/big`);
	await head;
	// No acknowledgements at all: the host may send its window plus at most the one chunk that
	// was already on its way when the window closed, and not a byte more.
	await sleep(700);
	const held = assemble(eventsFor(requestId).chunks).byteLength;
	expect(held).toBeGreaterThan(0);
	expect(held).toBeLessThanOrEqual(TUNNEL_WINDOW + TUNNEL_CHUNK);

	// Now consume: acknowledge what has arrived, over and over, until the stream ends.
	let acked = 0;
	const started = Date.now();
	for (;;) {
		const state = eventsFor(requestId);
		if (state.end || state.error) break;
		const received = assemble(state.chunks).byteLength;
		if (received > acked) {
			const delta = received - acked;
			acked = received;
			await client.call('tunnel', 'ack', { requestId, bytes: delta });
		}
		if (Date.now() - started > 20000) throw new Error('the big stream never finished');
		await sleep(20);
	}
	const finished = assemble(eventsFor(requestId).chunks);
	expect(eventsFor(requestId).error).toBeNull();
	expect(finished.byteLength).toBe(2 * 1024 * 1024);
	expect(finished[123]).toBe(123 % 251);
	expect(finished[finished.byteLength - 1]).toBe((finished.byteLength - 1) % 251);
});

test('an abort stops the stream without an ending', async () => {
	const { requestId, head } = openExchange(`${web.url}/slow`);
	await head;
	await waitFor(() => eventsFor(requestId).chunks.length > 0, 'the first tick');
	await client.call('tunnel', 'abort', { requestId });
	// Long enough for the whole little stream to have finished if the abort had done nothing.
	await sleep(400);
	const state = eventsFor(requestId);
	expect(state.end).toBeNull();
	expect(state.error).toBeNull();
});

test('the host answers busy instead of carrying unbounded requests', async () => {
	const hanging: Array<Promise<unknown>> = [];
	for (let index = 0; index < TUNNEL_MAX_STREAMS; index += 1) {
		hanging.push(
			client
				.call('tunnel', 'open', {
					requestId: `hang-${index}`,
					method: 'GET',
					url: `${web.url}/hang`,
					headers: {},
					bodyLength: 0
				})
				.catch(() => undefined)
		);
	}
	// The requests were sent in order on one channel, so the host has registered all of them by
	// the time this next message is read.
	const extra = await client.expectFailure('tunnel', 'open', {
		requestId: 'hang-extra',
		method: 'GET',
		url: `${web.url}/hang`,
		headers: {},
		bodyLength: 0
	});
	expect(extra.code).toBe('busy');

	for (let index = 0; index < TUNNEL_MAX_STREAMS; index += 1) {
		await client.call('tunnel', 'abort', { requestId: `hang-${index}` });
	}
	await Promise.all(hanging);
});

test('only http and https travel the tunnel', async () => {
	const failure = await client.expectFailure('tunnel', 'open', {
		requestId: 'scheme-1',
		method: 'GET',
		url: 'ftp://example.com/file',
		headers: {},
		bodyLength: 0
	});
	expect(failure.code).toBe('invalid');
});
