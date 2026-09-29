/**
 * End to end: a real daemon, a real relay, a real WebRTC handshake, a real config file.
 *
 * Everything the client does here travels the same path the browser app will take: a room join, an
 * SDP exchange through the relay, a DataChannel, the auth exchange, then RPC. Only the peer
 * implementation differs (werift instead of the browser stack), which is exactly the part
 * `protocol.ts` does not care about.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { RiozeLinkHost } from '../src/host.ts';
import {
	pairRoom,
	PROTOCOL_VERSION,
	VFS_CHUNK,
	WEB_CHUNK,
	type AuthOkPayload,
	type StatusInfoReply,
	type VfsShare
} from '../src/protocol.ts';
import { randomBytes, sha256Hex, toBase64 } from '../src/util.ts';
import {
	displayPhrase,
	isPhraseShaped,
	PHRASE_CODE_ALPHABET,
	PHRASE_CODE_LENGTH
} from '../src/words.ts';
import {
	offerAndStall,
	TestClient,
	mockAnki,
	mockOllama,
	startTestSignal,
	withTimeout
} from './support.ts';

const TEST_TIMEOUT = 30000;

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
	await withTimeout(
		new Promise<void>((resolve) => {
			const check = () => (predicate() ? resolve() : setTimeout(check, 50));
			check();
		}),
		timeoutMs,
		what
	);
}

/**
 * Waits until a reading stops moving, so numbers can be compared instead of raced against.
 *
 * Joining a room happens in the background, so "how many rooms this host is sitting in right now"
 * is only a fact once it has been the same answer twice.
 */
async function settle(read: () => number, quietMs = 300, tries = 20): Promise<number> {
	let last = read();
	for (let attempt = 0; attempt < tries; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, quietMs));
		const next = read();
		if (next === last) return next;
		last = next;
	}
	throw new Error('a reading never settled');
}

/** The code that is live right now. A code is minted, so asking is the only way to know one. */
function liveCode(): string {
	const code = host.pairingCode();
	if (!code) throw new Error('no pairing code is live');
	return code;
}

let root: string;
let shareDir: string;
let host: RiozeLinkHost;
let signalUrl: string;
let signal: { url: string; close(): Promise<void> };
let anki: { port: number; stop(): void };
let ollama: { port: number; stop(): void };
let primary: TestClient;
let primaryAuth: AuthOkPayload;

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'riozelink-test-'));
	shareDir = path.join(root, 'notes');
	await mkdir(path.join(shareDir, 'sub'), { recursive: true });
	await writeFile(path.join(shareDir, 'hello.txt'), 'hello from the host');
	await writeFile(path.join(shareDir, 'sub', 'nested.txt'), 'nested');
	anki = mockAnki();
	ollama = mockOllama();
	signal = await startTestSignal();
	signalUrl = signal.url;

	host = await RiozeLinkHost.create({
		configDir: path.join(root, 'config'),
		signal: signalUrl
	});
	host.config.anki.port = anki.port;
	host.config.ai.provider = 'ollama';
	host.config.ai.endpoint = `http://127.0.0.1:${ollama.port}`;
	host.config.ai.model = 'mock:latest';
	await host.createShare(shareDir, 'Notes');
	await host.start();
});

afterAll(async () => {
	primary?.close();
	await host.stop('the test finished');
	await signal.close();
	anki.stop();
	ollama.stop();
	await rm(root, { recursive: true, force: true });
});

test(
	'one code names one meeting point, however it is typed',
	async () => {
		expect(await pairRoom('amber-cobalt-summit-drift-4g2x')).toBe(
			await pairRoom('  Amber Cobalt-Summit_drift 4G2X ')
		);

		const phrase = liveCode();
		const parts = phrase.split('-');
		expect(parts.length).toBe(5);
		expect(parts[4]).toHaveLength(PHRASE_CODE_LENGTH);
		expect(
			[...parts[4]].every((character) => PHRASE_CODE_ALPHABET.includes(character.toUpperCase()))
		).toBe(true);
		expect(isPhraseShaped(phrase)).toBe(true);

		// What the panel prints is what a person types, so the display form has to derive the very
		// same room. Capitals and spaces are presentation, never part of the secret.
		expect(displayPhrase(phrase)).not.toContain('-');
		expect(displayPhrase(phrase)).toBe(displayPhrase(phrase).toUpperCase());
		expect(await pairRoom(displayPhrase(phrase))).toBe(await pairRoom(phrase));

		// The room name must not be a plain hash of the code. That would hand anyone who reads it
		// off the relay the whole code space at hash speed.
		expect(await pairRoom(phrase)).not.toBe(
			`rz-pair-${sha256Hex(`riozelink:room:v1:${phrase}`).slice(0, 24)}`
		);

		// A pairing room is named apart from the rooms paired ends return to, and both are stretched.
		expect((await pairRoom(phrase)).startsWith('rz-pair-')).toBe(true);

		await waitFor(() => host.openRooms() >= 1, 'the host to join a room');
		primary = await TestClient.connect(signalUrl, await pairRoom(phrase), {
			name: 'Test Browser'
		});
		const hello = await primary.hello();
		expect(hello.protocol).toBe(1);
		expect(hello.known).toBe(false);
		expect(hello.fingerprint.length).toBeGreaterThan(20);

		primaryAuth = await primary.pair(phrase);
		expect(primaryAuth.clientLabel).toBe('Test Browser');

		const status = (await primary.call('status', 'info')) as StatusInfoReply;
		expect(status.connectedClients).toBe(1);
		expect(status.shares.length).toBe(1);
		const share = status.shares[0] as VfsShare;
		expect(share.id).toBe('notes');
		expect(share.path).toBe(shareDir);

		const pong = (await primary.call('status', 'ping', { t: 1234 })) as { t: number };
		expect(pong.t).toBe(1234);
	},
	TEST_TIMEOUT
);

test(
	'a returning client proves its key instead of asking for words',
	async () => {
		const returning = await TestClient.connect(signalUrl, await primary.idForReconnect(), {
			name: 'Test Browser',
			keyPair: primary.keyPair
		});
		try {
			const hello = await returning.hello();
			expect(hello.known).toBe(true);
			expect(hello.clientLabel).toBe('Test Browser');
			const auth = await returning.prove();
			expect(auth.clientLabel).toBe('Test Browser');
			const status = (await returning.call('status', 'info')) as StatusInfoReply;
			expect(status.connectedClients).toBe(2);
		} finally {
			returning.close();
		}
		await withTimeout(
			new Promise<void>((resolve) => {
				const check = () => {
					if (host.readyClients() === 1) resolve();
					else setTimeout(check, 50);
				};
				check();
			}),
			8000,
			'the returning client to go away'
		);
	},
	TEST_TIMEOUT
);

test(
	'the shared folder lists, reads, writes, renames and removes',
	async () => {
		const listing = (await primary.call('vfs', 'list', { share: 'notes', path: '/' })) as {
			entries: Array<{ name: string; kind: string; size: number }>;
		};
		const names = listing.entries.map((entry) => entry.name);
		expect(names).toContain('hello.txt');
		expect(names).toContain('sub');
		expect(names.some((name) => name.includes('riozelink-part'))).toBe(false);

		const read = (await primary.call('vfs', 'read', {
			share: 'notes',
			path: '/hello.txt',
			offset: 0,
			length: VFS_CHUNK
		})) as { data: string; size: number; done: boolean };
		expect(Buffer.from(read.data, 'base64').toString('utf8')).toBe('hello from the host');
		expect(read.done).toBe(true);

		// A chunked write: one full chunk, then the tail. The file must not exist until the last
		// slice lands, and nothing may be left behind.
		const payload = randomBytes(Math.floor(VFS_CHUNK * 1.5));
		const first = payload.subarray(0, VFS_CHUNK);
		const second = payload.subarray(VFS_CHUNK);
		const firstReply = (await primary.call('vfs', 'write', {
			share: 'notes',
			path: '/big.bin',
			offset: 0,
			data: toBase64(first),
			done: false
		})) as { received: number };
		expect(firstReply.received).toBe(first.length);
		expect(await readFile(path.join(shareDir, 'big.bin')).catch(() => null)).toBeNull();
		await primary.call('vfs', 'write', {
			share: 'notes',
			path: '/big.bin',
			offset: first.length,
			data: toBase64(second),
			done: true
		});
		const written = await readFile(path.join(shareDir, 'big.bin'));
		expect(written.length).toBe(payload.length);

		await primary.call('vfs', 'mkdir', { share: 'notes', path: '/fresh' });
		const afterMkdir = (await primary.call('vfs', 'stat', { share: 'notes', path: '/fresh' })) as {
			entry: { kind: string } | null;
		};
		expect(afterMkdir.entry?.kind).toBe('dir');

		await primary.call('vfs', 'rename', {
			share: 'notes',
			from: '/hello.txt',
			to: '/sub/renamed.txt'
		});
		const renamed = await readFile(path.join(shareDir, 'sub', 'renamed.txt'), 'utf8');
		expect(renamed).toBe('hello from the host');

		const missing = (await primary.call('vfs', 'stat', {
			share: 'notes',
			path: '/renamed.txt'
		})) as {
			entry: unknown;
		};
		expect(missing.entry).toBeNull();

		await primary.call('vfs', 'remove', { share: 'notes', path: '/fresh' });
		const gone = (await primary.call('vfs', 'stat', { share: 'notes', path: '/fresh' })) as {
			entry: unknown;
		};
		expect(gone.entry).toBeNull();

		const listingsAfterWrite = (await primary.call('vfs', 'list', {
			share: 'notes',
			path: '/'
		})) as {
			entries: Array<{ name: string }>;
		};
		expect(listingsAfterWrite.entries.some((entry) => entry.name.includes('riozelink-part'))).toBe(
			false
		);
	},
	TEST_TIMEOUT
);

test(
	'paths outside the shared folder are refused, symlinks included',
	async () => {
		const outside = path.join(root, 'outside.txt');
		await writeFile(outside, 'not yours');

		const dotdot = await primary.expectFailure('vfs', 'read', {
			share: 'notes',
			path: '/../outside.txt',
			offset: 0,
			length: 100
		});
		expect(dotdot.code).toBe('denied');

		const relative = await primary.expectFailure('vfs', 'list', { share: 'notes', path: 'sub' });
		expect(relative.code).toBe('invalid');

		const unknownShare = await primary.expectFailure('vfs', 'list', { share: 'nope', path: '/' });
		expect(unknownShare.code).toBe('not-found');

		await symlink(outside, path.join(shareDir, 'leak.txt'));
		const leak = await primary.expectFailure('vfs', 'read', {
			share: 'notes',
			path: '/leak.txt',
			offset: 0,
			length: 100
		});
		expect(leak.code).toBe('denied');
		await rm(path.join(shareDir, 'leak.txt'), { force: true });
	},
	TEST_TIMEOUT
);

test(
	'the web proxy fetches a page, unframes it and chunks it back',
	async () => {
		const site = Bun.serve({
			port: 0,
			fetch: (request) => {
				const url = new URL(request.url);
				if (url.pathname === '/') {
					return new Response(
						'<!doctype html><html><head>' +
							'<meta http-equiv="Content-Security-Policy" content="frame-ancestors \'none\'">' +
							'<meta http-equiv="refresh" content="0; url=/elsewhere">' +
							'<title>  A little   page </title></head>' +
							'<body><a href="/next">next</a><img src="pic.png"></body></html>',
						{ headers: { 'content-type': 'text/html; charset=utf-8' } }
					);
				}
				if (url.pathname === '/big') {
					return new Response(`<html><body>${'x'.repeat(200_000)}</body></html>`, {
						headers: { 'content-type': 'text/html' }
					});
				}
				if (url.pathname === '/json') return Response.json({ ok: true });
				if (url.pathname === '/xfo') {
					return new Response('<html><body>no</body></html>', {
						headers: { 'content-type': 'text/html', 'x-frame-options': 'sameorigin' }
					});
				}
				if (url.pathname === '/ancestors') {
					return new Response('<html><body>no</body></html>', {
						headers: {
							'content-type': 'text/html',
							'content-security-policy': "default-src 'self'; frame-ancestors 'none'"
						}
					});
				}
				return new Response('nope', { status: 404 });
			}
		});
		const origin = `http://127.0.0.1:${site.port}`;
		try {
			const meta = (await primary.call('web', 'fetch', { url: `${origin}/` })) as {
				id: string;
				url: string;
				title: string | null;
				size: number;
				truncated: boolean;
			};
			expect(meta.title).toBe('A little page');
			expect(meta.url).toBe(`${origin}/`);
			expect(meta.truncated).toBe(false);

			let html = '';
			let offset = 0;
			let done = false;
			while (!done) {
				const chunk = (await primary.call('web', 'read', {
					id: meta.id,
					offset,
					length: WEB_CHUNK
				})) as { data: string; size: number; done: boolean };
				const bytes = Buffer.from(chunk.data, 'base64');
				html += bytes.toString('utf8');
				offset += bytes.length;
				done = chunk.done;
			}
			expect(html).toContain(`<base href="${origin}/">`);
			expect(html).not.toContain('frame-ancestors');
			expect(html).not.toContain('http-equiv="refresh"');
			expect(html).toContain('data-rioze-link="bridge"');
			expect(html).toContain('postMessage');

			// A page that is bigger than one message arrives over several.
			const big = (await primary.call('web', 'fetch', { url: `${origin}/big` })) as {
				id: string;
				size: number;
			};
			expect(big.size).toBeGreaterThan(WEB_CHUNK);
			const first = (await primary.call('web', 'read', {
				id: big.id,
				offset: 0,
				length: WEB_CHUNK
			})) as { done: boolean };
			expect(first.done).toBe(false);
			const last = (await primary.call('web', 'read', {
				id: big.id,
				offset: big.size - 10,
				length: WEB_CHUNK
			})) as { done: boolean };
			expect(last.done).toBe(true);

			// Four pages are kept, and the fifth pushes the oldest one out.
			for (let index = 0; index < 4; index += 1) {
				await primary.call('web', 'fetch', { url: `${origin}/?${index}` });
			}
			const evicted = await primary.expectFailure('web', 'read', {
				id: meta.id,
				offset: 0,
				length: 10
			});
			expect(evicted.code).toBe('not-found');

			const notHtml = await primary.expectFailure('web', 'fetch', { url: `${origin}/json` });
			expect(notHtml.code).toBe('unsupported');
			expect(notHtml.message).toContain('json');

			// The probe reads headers only, and is the signal the browser uses to tell a refused
			// page apart from one that simply loaded quickly.
			const xfo = (await primary.call('web', 'probe', { url: `${origin}/xfo` })) as {
				framing: string | null;
				detail: string | null;
			};
			expect(xfo.framing).toBe('x-frame-options');
			expect(xfo.detail).toContain('sameorigin');
			const ancestors = (await primary.call('web', 'probe', { url: `${origin}/ancestors` })) as {
				framing: string | null;
				detail: string | null;
			};
			expect(ancestors.framing).toBe('frame-ancestors');
			const plain = (await primary.call('web', 'probe', { url: `${origin}/` })) as {
				framing: string | null;
			};
			expect(plain.framing).toBeNull();
			const unreachable = await primary.expectFailure('web', 'probe', {
				url: 'http://127.0.0.1:1/'
			});
			expect(unreachable.code).toBe('offline');

			const scheme = await primary.expectFailure('web', 'fetch', { url: 'file:///etc/passwd' });
			expect(scheme.code).toBe('invalid');

			const dead = await primary.expectFailure('web', 'fetch', { url: 'http://127.0.0.1:1/' });
			expect(dead.code).toBe('offline');

			// The proxy is the host's switch, not the browser's: turning it off refuses every
			// web action, and the answer is what a client that connects later reads too.
			const off = (await primary.call('web', 'set-enabled', { enabled: false })) as {
				enabled: boolean;
			};
			expect(off.enabled).toBe(false);
			expect(((await primary.call('status', 'info', {})) as { webEnabled: boolean }).webEnabled).toBe(
				false
			);
			const refusedFetch = await primary.expectFailure('web', 'fetch', { url: `${origin}/` });
			expect(refusedFetch.code).toBe('denied');
			const refusedProbe = await primary.expectFailure('web', 'probe', { url: `${origin}/` });
			expect(refusedProbe.code).toBe('denied');
			const refusedRead = await primary.expectFailure('web', 'read', {
				id: meta.id,
				offset: 0,
				length: 10
			});
			expect(refusedRead.code).toBe('denied');
			// Turning it back on is the one action that has to keep working while it is off.
			const on = (await primary.call('web', 'set-enabled', { enabled: true })) as {
				enabled: boolean;
			};
			expect(on.enabled).toBe(true);
			expect(((await primary.call('status', 'info', {})) as { webEnabled: boolean }).webEnabled).toBe(
				true
			);
			// And the config is a real file, so the switch survives a restart.
			const saved = JSON.parse(
				await readFile(path.join(root, 'config', 'config.json'), 'utf8')
			) as { web?: { enabled?: boolean } };
			expect(saved.web?.enabled).toBe(true);
		} finally {
			site.stop(true);
		}
	},
	TEST_TIMEOUT
);

test(
	'Anki is off by default, turns on, answers and reports failures',
	async () => {
		const off = (await primary.call('anki', 'status')) as { enabled: boolean; reachable: boolean };
		expect(off.enabled).toBe(false);
		expect(off.reachable).toBe(false);
		const refused = await primary.expectFailure('anki', 'invoke', { action: 'version' });
		expect(refused.code).toBe('denied');

		const on = (await primary.call('anki', 'set-enabled', { enabled: true })) as {
			enabled: boolean;
			reachable: boolean;
			version: number | null;
		};
		expect(on.enabled).toBe(true);
		expect(on.reachable).toBe(true);
		expect(on.version).toBe(6);

		const decks = (await primary.call('anki', 'invoke', { action: 'deckNames' })) as {
			result: string[];
		};
		expect(decks.result).toEqual(['Default']);

		const failed = await primary.expectFailure('anki', 'invoke', { action: 'nonsense' });
		expect(failed.code).toBe('io');
		expect(failed.message).toContain('unsupported action');

		await primary.call('anki', 'set-enabled', { enabled: false });
	},
	TEST_TIMEOUT
);

test(
	'the AI gateway is off until asked, then streams and only ever sends back a masked key',
	async () => {
		const before = (await primary.call('ai', 'status')) as {
			enabled: boolean;
			keySet: boolean;
			keyMasked: string | null;
		};
		expect(before.enabled).toBe(false);
		expect(before.keySet).toBe(false);
		expect(before.keyMasked).toBeNull();

		// Off really means off: a chat does not reach the endpoint at all.
		const refused = await primary.expectFailure('ai', 'chat', {
			streamId: 'stream-off',
			messages: [{ role: 'user', content: 'hello?' }]
		});
		expect(refused.code).toBe('denied');

		const enabled = (await primary.call('ai', 'config', { enabled: true })) as { enabled: boolean };
		expect(enabled.enabled).toBe(true);

		const key = 'sk-secret-abcdef1234';
		const withKey = (await primary.call('ai', 'set-key', { key })) as {
			keySet: boolean;
			keyMasked: string | null;
		};
		expect(withKey.keySet).toBe(true);
		expect(withKey.keyMasked).toBe('sk-...1234');
		expect(JSON.stringify(withKey)).not.toContain('secret');

		const status = (await primary.call('ai', 'status')) as {
			available: boolean;
			models: string[];
			provider: string;
			endpoint: string;
			model: string;
		};
		expect(status.provider).toBe('ollama');
		expect(status.endpoint).toBe(`http://127.0.0.1:${ollama.port}`);
		expect(status.model).toBe('mock:latest');
		expect(status.available).toBe(true);
		expect(status.models).toContain('mock:latest');

		const endPromise = primary.waitForEvent('ai', 'end');
		await primary.call('ai', 'chat', {
			streamId: 'stream-1',
			messages: [{ role: 'user', content: 'say hello' }]
		});
		const end = (await endPromise) as { payload: { streamId: string; text: string } };
		expect(end.payload.streamId).toBe('stream-1');
		expect(end.payload.text).toBe('Hello from the mock.');
		const chunks = primary.events
			.filter((event) => event.action === 'chunk')
			.map((event) => (event.payload as { delta: string }).delta);
		expect(chunks.join('')).toBe('Hello from the mock.');

		await primary.call('ai', 'clear-key');
		const cleared = (await primary.call('ai', 'status')) as { keySet: boolean };
		expect(cleared.keySet).toBe(false);
	},
	TEST_TIMEOUT
);

test(
	'a change on the host disk is pushed to the client',
	async () => {
		const changed = primary.waitForEvent(
			'vfs',
			'changed',
			(event) => (event.payload as { path: string }).path === '/appeared.txt'
		);
		await writeFile(path.join(shareDir, 'appeared.txt'), 'fresh');
		const event = (await changed) as {
			payload: { shareId: string; kind: string; path: string };
		};
		expect(event.payload.shareId).toBe('notes');
		expect(event.payload.path).toBe('/appeared.txt');
	},
	TEST_TIMEOUT
);

test(
	'a second client pairs with a fresh code, and both see the aggregate count',
	async () => {
		// A code is spent the moment a browser pairs with it, so this pairing mints its own.
		host.mintPairingCode();
		const phrase = liveCode();
		const second = await TestClient.connect(signalUrl, await pairRoom(phrase), {
			name: 'Second Window'
		});
		try {
			const hello = await second.hello();
			expect(hello.known).toBe(false);
			const auth = await second.pair(phrase);
			expect(auth.clientLabel).toBe('Second Window');
			expect(host.readyClients()).toBe(2);

			const seen = await primary.call('status', 'info');
			expect((seen as StatusInfoReply).connectedClients).toBe(2);

			const listing = (await second.call('vfs', 'list', { share: 'notes', path: '/' })) as {
				entries: unknown[];
			};
			expect(listing.entries.length).toBeGreaterThan(0);
		} finally {
			second.close();
		}

		// The used code is retired, so the impostor needs a fresh one to fail against. It can find the
		// room, and that is as far as it gets.
		host.mintPairingCode();
		const impostor = await TestClient.connect(signalUrl, await pairRoom(liveCode()), {
			name: 'Impostor'
		});
		try {
			await impostor.hello();
			const failure = await impostor.expectFailure(
				'auth',
				'pair',
				await impostor.pairPayload('definitely-not-the-real-code')
			);
			expect(failure.code).toBe('auth');
		} finally {
			impostor.close();
		}

		const config = await loadConfig(path.join(root, 'config', 'config.json'));
		expect(Object.keys(config.authorizedClients).length).toBe(2);
	},
	TEST_TIMEOUT
);

test(
	'a stalled attempt does not block the next browser',
	async () => {
		// One browser offers and never applies the answer. The daemon has a peer that believes it
		// is mid-handshake, and left alone it would ignore every offer that follows — the state a
		// reload used to land in, where the link only came back after the daemon was restarted.
		host.mintPairingCode();
		const target = await pairRoom(liveCode());
		const stalled = await offerAndStall(signalUrl, target);
		try {
			// Give the host time to build that peer and answer the offer that goes nowhere.
			await new Promise((resolve) => setTimeout(resolve, 1500));
			const fresh = await TestClient.connect(signalUrl, target, {
				name: 'After the stall'
			});
			try {
				const hello = await fresh.hello();
				expect(hello.protocol).toBe(PROTOCOL_VERSION);
				expect(hello.known).toBe(false);
			} finally {
				fresh.close();
			}
		} finally {
			stalled.close();
		}
	},
	TEST_TIMEOUT
);

test(
	'a code expires on its own, and takes its room with it',
	async () => {
		// A second daemon whose code is worth almost nothing, so the timer can be watched rather than
		// waited on. Everything else about it is a normal daemon.
		const short = await RiozeLinkHost.create({
			configDir: path.join(root, 'short-config'),
			signal: signalUrl,
			pairingTtlMs: 600
		});
		try {
			await short.start();
			expect(short.pairingCode()).not.toBeNull();
			expect(short.pairingRemainingMs()).toBeLessThanOrEqual(600);
			// One registration, the pairing room, and nothing else this daemon holds.
			await waitFor(() => short.openRooms() === 1, 'the pairing room to open');

			await waitFor(() => short.pairingCode() === null, 'the code to expire on its own', 5000);
			expect(short.pairingRemainingMs()).toBe(0);
			await waitFor(() => short.openRooms() === 0, 'the room to come down with it');

			// And it stays expired. Nothing mints a replacement while nobody is asking.
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(short.pairingCode()).toBeNull();
		} finally {
			await short.stop('the test finished with it');
		}
	},
	TEST_TIMEOUT
);

test(
	'a code is minted on demand, and retiring it takes the room down',
	async () => {
		// Whatever the tests before this one left behind, start from no code at all.
		host.retirePairingCode('the test started from nothing');
		expect(host.pairingCode()).toBeNull();
		expect(host.pairingRemainingMs()).toBe(0);

		host.mintPairingCode();
		const code = host.pairingCode();
		if (!code) throw new Error('a minted code should be live');
		expect(code.split('-').length).toBe(5);
		expect(host.pairingRemainingMs()).toBeGreaterThan(0);
		expect(host.pairingRemainingMs()).toBeLessThanOrEqual(3 * 60_000);

		// The room is the only thing a stranger can even find, and minting is what opens it.
		const withRoom = await settle(() => host.openRooms());
		expect(withRoom).toBeGreaterThan(0);

		host.retirePairingCode('the test was done with it');
		expect(host.pairingCode()).toBeNull();
		expect(host.pairingRemainingMs()).toBe(0);
		const withoutRoom = await settle(() => host.openRooms());
		expect(withoutRoom).toBe(withRoom - 1);

		// Nothing renews one on its own, however long the daemon sits there.
		expect(host.pairingCode()).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(host.pairingCode()).toBeNull();
	},
	TEST_TIMEOUT
);
