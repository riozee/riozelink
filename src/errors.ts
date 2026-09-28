/**
 * The daemon's one error type, and the bridge to the wire.
 *
 * Handler code throws {@link HostError} with a code the client can branch on. Anything else that
 * escapes (a stray `ENOENT`, a fetch failure) is translated on the way out, so every reply is a
 * well-formed `RpcErrorInfo` and no reply ever leaks a stack trace.
 */
import type { RpcErrorCode, RpcErrorInfo } from './protocol.ts';

export class HostError extends Error {
	readonly code: RpcErrorCode;

	constructor(message: string, code: RpcErrorCode = 'invalid') {
		super(message);
		this.name = 'HostError';
		this.code = code;
	}
}

/** `ENOENT` and friends, mapped onto the codes the client understands. */
export function errnoCode(code: string | undefined): RpcErrorCode {
	switch (code) {
		case 'ENOENT':
			return 'not-found';
		case 'EACCES':
		case 'EPERM':
		case 'EROFS':
			return 'denied';
		case 'EEXIST':
			return 'exists';
		case 'ENOTDIR':
		case 'EISDIR':
		case 'EINVAL':
		case 'ENOTEMPTY':
		case 'ELOOP':
		case 'ENAMETOOLONG':
			return 'invalid';
		case 'ENOSPC':
		case 'EDQUOT':
			return 'quota';
		case 'EBUSY':
			return 'busy';
		case 'ECONNREFUSED':
		case 'ECONNRESET':
		case 'EHOSTUNREACH':
		case 'ENETUNREACH':
			return 'offline';
		default:
			return 'unknown';
	}
}

export function toErrorInfo(error: unknown): RpcErrorInfo {
	if (error instanceof HostError) return { code: error.code, message: error.message };
	const errno = (error as NodeJS.ErrnoException | undefined)?.code;
	if (typeof errno === 'string') {
		const code = errnoCode(errno);
		const message = error instanceof Error ? error.message : String(error);
		return { code, message };
	}
	if (error instanceof Error) return { code: 'unknown', message: error.message };
	return { code: 'unknown', message: String(error) };
}

/* Payload validation. The client is trusted after auth, but a bug on either side should read as a
 * clean protocol error rather than as a half-executed operation. */

export function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new HostError(`invalid payload, ${field} must be a non-empty string`, 'invalid');
	}
	return value;
}

export function requireNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new HostError(`invalid payload, ${field} must be a number`, 'invalid');
	}
	return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireString(value, field);
}

export function requireArray(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new HostError(`invalid payload, ${field} must be an array`, 'invalid');
	}
	return value;
}
