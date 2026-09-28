/**
 * Small shared helpers. Nothing here knows about RiozeOS.
 */
import path from 'node:path';
import { createHash, randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto';

/** A fresh request, session or stream id. */
export function randomId(): string {
	return randomUUID();
}

export function randomBytes(size: number): Buffer {
	return nodeRandomBytes(size);
}

/**
 * 32 random bytes as base64. Standard base64, not the URL-safe alphabet: the client decodes
 * these with `atob`, which knows nothing about `-` and `_`.
 */
export function randomNonce(): string {
	return nodeRandomBytes(32).toString('base64');
}

export function toBase64(data: Uint8Array): string {
	return Buffer.from(data).toString('base64');
}

/**
 * Base64 back to bytes, copied into a plain `ArrayBuffer`. WebCrypto is strict about the buffer
 * behind its arguments, and this is the one place that is fixed, so no caller has to think about it.
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(Buffer.from(text, 'base64'));
}

export function sha256Hex(data: Uint8Array | string): string {
	return createHash('sha256').update(data).digest('hex');
}

/** `ab12cd34…` in groups of four, for humans reading it off two screens. */
export function formatFingerprint(hex: string): string {
	return (hex.match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * The one place a key is ever turned back into text. Short keys are hidden completely, longer
 * ones keep their head and tail so the user can tell two of them apart.
 */
export function maskKey(key: string): string {
	if (key.length <= 8) return '••••••';
	return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

/** A safe folder id from a label. `Notes 2026` → `notes-2026`. */
export function slugify(text: string): string {
	const plain = text
		.normalize('NFKD')
		.replaceAll(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return plain || 'share';
}

/** True when `candidate` is `root` itself or sits inside it. Both are absolute paths. */
export function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `2h 05m`, `14m 32s`, `8s` — for the dashboard, never for copy. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
	return `${seconds}s`;
}

/** A short, safe display form of a local path, for log lines. */
export function displayPath(target: string): string {
	const home = process.env.HOME;
	if (home && isWithin(home, target)) {
		const relative = path.relative(home, target);
		return relative ? `~/${relative}` : '~';
	}
	return target;
}
