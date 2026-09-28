/**
 * End to end: a real daemon, a real relay, a real WebRTC handshake, a real config file.
 *
 * Everything the client does here travels the same path the browser app will take: a WebSocket
 * join to the relay, an SDP exchange, a DataChannel, the auth exchange, then RPC. Only the peer
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
	VFS_CHUNK,
	pairRoom,
	type AuthOkPayload,
	type StatusInfoReply,
	type VfsShare
} from '../src/protocol.ts';
import type { RelayServer } from '../src/relay-server.ts';
import { randomBytes, toBase64 } from '../src/util.ts';
import { TestClient, mockAnki, mockOllama, startTestRelay, withTimeout } from './support.ts';

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

let root: string;
let shareDir: string;
let host: RiozeLinkHost;
let relayUrl: string;
let relay: RelayServer;
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
	const started = await startTestRelay();
	relayUrl = started.url;
	relay = started.server;

	host = await RiozeLinkHost.create({
		configDir: path.join(root, 'config'),
		relay: relayUrl
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
	await relay.close();
	anki.stop();
	ollama.stop();
	await rm(root, { recursive: true, force: true });
});

test(
	'one phrase names one room, however it is typed',
	async () => {
		expect(await pairRoom('amber-cobalt-summit-drift')).toBe(
			await pairRoom('  Amber Cobalt-Summit_drift  ')
		);
		const phrase = host.currentPairingPhrase();
		expect(phrase.split('-').length).toBe(4);
			await waitFor(() => host.anchoredRooms() >= 1, 'the host to reach the relay');
		primary = await TestClient.connect(relayUrl, await pairRoom(phrase), {
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
		expect(status.relay).toBe(relayUrl);
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
		const returning = await TestClient.connect(relayUrl, await primary.roomForReconnect(), {
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

		await primary.call('vfs', 'rename', { share: 'notes', from: '/hello.txt', to: '/sub/renamed.txt' });
		const renamed = await readFile(path.join(shareDir, 'sub', 'renamed.txt'), 'utf8');
		expect(renamed).toBe('hello from the host');

		const missing = (await primary.call('vfs', 'stat', { share: 'notes', path: '/renamed.txt' })) as {
			entry: unknown;
		};
		expect(missing.entry).toBeNull();

		await primary.call('vfs', 'remove', { share: 'notes', path: '/fresh' });
		const gone = (await primary.call('vfs', 'stat', { share: 'notes', path: '/fresh' })) as {
			entry: unknown;
		};
		expect(gone.entry).toBeNull();

		const listingsAfterWrite = (await primary.call('vfs', 'list', { share: 'notes', path: '/' })) as {
			entries: Array<{ name: string }>;
		};
		expect(listingsAfterWrite.entries.some((entry) => entry.name.includes('riozelink-part'))).toBe(false);
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
	'a second client pairs with fresh words, and both see the aggregate count',
	async () => {
		const phrase = host.currentPairingPhrase();
		const second = await TestClient.connect(relayUrl, await pairRoom(phrase), {
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

		// The used words are retired. Someone who found the room but not the words is turned away,
		// which is exactly what the proof and the failure limit are for.
		const impostor = await TestClient.connect(
			relayUrl,
			await pairRoom(host.currentPairingPhrase()),
			{ name: 'Impostor' }
		);
		try {
			await impostor.hello();
			const failure = await impostor.expectFailure(
				'auth',
				'pair',
				await impostor.pairPayload('definitely-not-the-four-words')
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
