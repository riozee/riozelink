/**
 * The app mirror has to derive exactly what this repository derives.
 *
 * riozeOS keeps a hand-written copy of a few runtime values from `src/protocol.ts` and `src/words.ts`,
 * because the root project takes only *types* from this repository. A copy can drift, and the end to
 * end suite cannot notice: its client derives the room with the daemon's own helper, so it agrees
 * with the daemon no matter what the browser computes. That is how `normalizePhrase` came to strip
 * digits on one side only, which meant a code with a digit in its tail named two different rooms and
 * pairing hung forever on both ends.
 *
 * So this is the one place both implementations stand in the same room. Every value either side
 * derives or compares is derived here twice and held against the other.
 *
 * The mirror lives in the riozeOS repository, one level above this one. Run from a standalone
 * checkout of this repository there is nothing to compare, and the test says so instead of failing.
 */
import { describe, expect, test } from 'bun:test';
import { fingerprintOfPublicKey } from '../src/identity.ts';
import * as Words from '../src/words.ts';
import * as Daemon from '../src/protocol.ts';
import { toBase64 } from '../src/util.ts';

const MIRROR_PATH = new URL('../../src/lib/apps/com.riozelink.svelte/protocol.ts', import.meta.url);

const mirror = (await Bun.file(MIRROR_PATH).exists())
	? await import(MIRROR_PATH.href)
	: null;

if (!mirror) {
	console.log(
		'the riozeOS app mirror is not next to this checkout, so only the daemon side is checked'
	);
}

/** Codes worth disagreeing over. Every one carries digits, which is the part that was dropped. */
const CODES = [
	'cedar-wassel-olive-fog-2r3q',
	'HORSE CLOUD TOWER ALMOND F0J8',
	'  Amber Cobalt-Summit_drift 4G2X ',
	'amber-cobalt-summit-drift-4g2x',
	'yarn-sugar-library-cellar-GTBG'
];

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';

describe('the daemon agrees with itself', () => {
	test('a phrase keeps its digits, whatever a person did to it', () => {
		// The values are written out rather than compared against a second call, so the daemon's own
		// spelling is pinned even when the app is not there to compare against.
		expect(Daemon.normalizePhrase('cedar-wassel-olive-fog-2r3q')).toBe(
			'cedar-wassel-olive-fog-2r3q'
		);
		expect(Daemon.normalizePhrase('HORSE CLOUD TOWER ALMOND F0J8')).toBe(
			'horse-cloud-tower-almond-f0j8'
		);
		expect(Daemon.normalizePhrase('  Amber Cobalt-Summit_drift 4G2X ')).toBe(
			'amber-cobalt-summit-drift-4g2x'
		);
		// A tail of four letters is the case that hid the bug for a whole round, because nothing was
		// there to drop.
		expect(Daemon.normalizePhrase('yarn-sugar-library-cellar-GTBG')).toBe(
			'yarn-sugar-library-cellar-gtbg'
		);
	});

	test('shape means three to six words and a code tail', () => {
		expect(Daemon.isPhraseShaped('cedar-wassel-olive-fog-2r3q')).toBe(true);
		expect(Daemon.isPhraseShaped('horse cloud tower almond f0j8')).toBe(true);
		expect(Daemon.isPhraseShaped('three random words')).toBe(false);
		expect(Daemon.isPhraseShaped('one-two-three-four-five-six-seven-ab12')).toBe(false);
		expect(Daemon.isPhraseShaped('cedar-wassel-olive-fog-ab')).toBe(false);
		// `I`, `L`, `O` and `U` are not in the tail alphabet, so a tail that has one is a typo.
		expect(Daemon.isPhraseShaped('cedar-wassel-olive-fog-ILOU')).toBe(false);
	});
});

describe.skipIf(!mirror)('the app mirror agrees with the daemon', () => {
	test('the constants are the same value, not just the same type', () => {
		expect(mirror.PROTOCOL_VERSION).toBe(Daemon.PROTOCOL_VERSION);
		expect(mirror.PAIR_KDF_ITERATIONS).toBe(Daemon.PAIR_KDF_ITERATIONS);
		expect(mirror.PAIR_KDF_SALT).toBe(Daemon.PAIR_KDF_SALT);
		expect(mirror.ROOM_KDF_SALT).toBe(Daemon.ROOM_KDF_SALT);
		expect(mirror.VFS_CHUNK).toBe(Daemon.VFS_CHUNK);
		expect(mirror.TUNNEL_CHUNK).toBe(Daemon.TUNNEL_CHUNK);
		expect(mirror.TUNNEL_MAX_BODY).toBe(Daemon.TUNNEL_MAX_BODY);
		expect(mirror.TUNNEL_MAX_STREAMS).toBe(Daemon.TUNNEL_MAX_STREAMS);
		expect(mirror.TUNNEL_WINDOW).toBe(Daemon.TUNNEL_WINDOW);
		expect(mirror.SIGNAL_URL).toBe(Daemon.SIGNAL_URL);
		expect(mirror.SIGNAL_SUBPROTOCOL).toBe(Daemon.SIGNAL_SUBPROTOCOL);
		expect(mirror.SIGNAL_MAX_FRAME).toBe(Daemon.SIGNAL_MAX_FRAME);
		expect(mirror.PHRASE_CODE_ALPHABET).toBe(Words.PHRASE_CODE_ALPHABET);
		expect(mirror.PHRASE_CODE_LENGTH).toBe(Words.PHRASE_CODE_LENGTH);
	});

	test('a phrase means the same thing on both ends', () => {
		for (const code of CODES) {
			expect(mirror.normalizePhrase(code)).toBe(Daemon.normalizePhrase(code));
			expect(mirror.isPhraseShaped(code)).toBe(Daemon.isPhraseShaped(code));
		}
		expect(mirror.isPhraseShaped('three random words')).toBe(
			Daemon.isPhraseShaped('three random words')
		);
		expect(mirror.normalizePhrase('a---b  c')).toBe(Daemon.normalizePhrase('a---b  c'));
	});

	test('the room names are derived the same, which is the whole handshake', async () => {
		for (const code of CODES) {
			expect(await mirror.pairRoom(code)).toBe(await Daemon.pairRoom(code));
		}
		expect(await mirror.linkRoom('AA11', 'bb22')).toBe(await Daemon.linkRoom('aa11', 'bb22'));
	});

	test('the pairing proof is the same bytes', async () => {
		for (const code of CODES) {
			expect(await mirror.pairProof(code, NONCE)).toBe(await Daemon.pairProof(code, NONCE));
		}
	});

	test('the relay socket is built the same, and a frame is measured the same', async () => {
		const room = await Daemon.pairRoom(CODES[0]);
		expect(mirror.signalSocketUrl(mirror.SIGNAL_URL, room)).toBe(
			Daemon.signalSocketUrl(Daemon.SIGNAL_URL, room)
		);
		// Both ends ask before sending, because the relay closes the socket over an oversized frame.
		expect(mirror.fitsRelayFrame('a'.repeat(Daemon.SIGNAL_MAX_FRAME))).toBe(true);
		expect(mirror.fitsRelayFrame('a'.repeat(Daemon.SIGNAL_MAX_FRAME + 1))).toBe(false);
		// Measured in bytes, not characters, so a multi-byte frame is the one that slips through.
		const wide = 'あ'.repeat(Math.floor(Daemon.SIGNAL_MAX_FRAME / 3));
		expect(mirror.fitsRelayFrame(wide)).toBe(Daemon.fitsRelayFrame(wide));
		expect(mirror.fitsRelayFrame(`${wide}あ`)).toBe(Daemon.fitsRelayFrame(`${wide}あ`));
	});

	test('an id looks the same and a digest is the same', async () => {
		for (const id of ['rz-c', 'rz-h'] as const) {
			expect(mirror.makePeerId(id)).toMatch(/^rz-[ch]-[0-9a-f]{12}$/);
			expect(Daemon.makePeerId(id)).toMatch(/^rz-[ch]-[0-9a-f]{12}$/);
		}
		expect(mirror.makePeerId('rz-c')).not.toBe(Daemon.makePeerId('rz-c'));
		expect(await mirror.sha256Hex('riozelink')).toBe(await Daemon.sha256Hex('riozelink'));
	});

	test('a public key has the same fingerprint on both ends', async () => {
		// This one names the room a paired browser returns to, so a disagreement here would let a
		// first pairing work and every visit after it hang.
		const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
			'sign',
			'verify'
		]);
		const spki = toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
		expect(await mirror.fingerprintOfPublicKey(spki)).toBe(
			fingerprintOfPublicKey(spki).fingerprintHex
		);
	});
});
