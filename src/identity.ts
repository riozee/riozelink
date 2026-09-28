/**
 * The host's cryptographic identity.
 *
 * One ECDSA P-256 key pair per daemon installation, generated on first start and kept in the
 * config directory with `0600`. The public half is what the client pins on first pairing; the
 * private half signs the client's nonce on every hello, which is how a returning client knows it
 * found the same host and not something else answering on the same address.
 *
 * Everything here is WebCrypto, the same API the browser client uses, so signature formats match
 * without a translation layer.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex, formatFingerprint, fromBase64, toBase64 } from './util.ts';
export interface HostIdentity {
	/** SPKI DER, base64. Public by definition. */
	publicKey: string;
	/** PKCS8 DER, base64. Never leaves the machine. */
	privateKey: string;
	/** `ab12 cd34 …`, for humans. */
	fingerprint: string;
	/** `ab12cd34…`, for room names and config keys. */
	fingerprintHex: string;
	createdAt: number;
}

const KEY_PARAMS: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

function fingerprintOf(spki: Uint8Array): { fingerprint: string; fingerprintHex: string } {
	const hex = sha256Hex(spki);
	return { fingerprint: formatFingerprint(hex), fingerprintHex: hex };
}

async function generateIdentity(): Promise<Omit<HostIdentity, 'fingerprint' | 'fingerprintHex'>> {
	const pair = await crypto.subtle.generateKey(KEY_PARAMS, true, ['sign', 'verify']);
	const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
	const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
	return {
		publicKey: toBase64(new Uint8Array(spki)),
		privateKey: toBase64(new Uint8Array(pkcs8)),
		createdAt: Date.now()
	};
}

async function importPrivateKey(pkcs8Base64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('pkcs8', fromBase64(pkcs8Base64), KEY_PARAMS, false, ['sign']);
}

/** Imports a client or host public key. Throws on anything that is not a valid P-256 SPKI. */
export async function importPublicKey(spkiBase64: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('spki', fromBase64(spkiBase64), KEY_PARAMS, false, ['verify']);
}

export async function loadOrCreateIdentity(directory: string): Promise<HostIdentity> {
	const file = path.join(directory, 'identity.json');
	let stored: Omit<HostIdentity, 'fingerprint' | 'fingerprintHex'> | null = null;
	try {
		const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
		if (typeof raw.publicKey === 'string' && typeof raw.privateKey === 'string') {
			stored = {
				publicKey: raw.publicKey,
				privateKey: raw.privateKey,
				createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
			};
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
	}

	if (!stored) {
		stored = await generateIdentity();
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(file, `${JSON.stringify(stored, null, '\t')}\n`, {
			encoding: 'utf8',
			mode: 0o600
		});
		await chmod(file, 0o600).catch(() => undefined);
	}

	const { fingerprint, fingerprintHex } = fingerprintOf(fromBase64(stored.publicKey));
	return { ...stored, fingerprint, fingerprintHex };
}

/** Signs with the host key. The result is the raw 64-byte `r||s` WebCrypto form. */
export async function sign(
	identity: HostIdentity,
	data: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
	const key = await importPrivateKey(identity.privateKey);
	const signature = await crypto.subtle.sign(SIGN_PARAMS, key, new Uint8Array(data));
	return new Uint8Array(signature);
}

/** Verifies a signature made by any ECDSA P-256 WebCrypto key, client or host. */
export async function verify(
	publicKeyBase64: string,
	signature: Uint8Array,
	data: Uint8Array
): Promise<boolean> {
	try {
		const key = await importPublicKey(publicKeyBase64);
		return await crypto.subtle.verify(
			SIGN_PARAMS,
			key,
			new Uint8Array(signature),
			new Uint8Array(data)
		);
	} catch {
		return false;
	}
}

export function fingerprintOfPublicKey(publicKeyBase64: string): {
	fingerprint: string;
	fingerprintHex: string;
} {
	return fingerprintOf(fromBase64(publicKeyBase64));
}
