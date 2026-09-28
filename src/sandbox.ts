/**
 * The fence around every shared folder.
 *
 * RiozeOS asks for paths the way it asks its own filesystem: POSIX, absolute, `/` meaning the
 * root of that share. This module is the only place those paths are turned into host paths, and
 * it refuses anything that would leave the configured folder — `..` segments, absolute paths,
 * backslash tricks, and symlinks that point outside.
 *
 * The check walks up to the deepest part of the path that exists and asks the OS for its real
 * location, so a symlink planted anywhere along the way is seen for where it actually points.
 * The parts above a file that is about to be created cannot contain a symlink yet, which is the
 * accepted window: nothing is created before the check has passed.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ShareRecord } from './config.ts';
import { HostError } from './errors.ts';
import { isWithin } from './util.ts';

const realRoots = new Map<string, string>();

export function normalizeRemotePath(input: string): string {
	if (typeof input !== 'string' || input.length === 0) {
		throw new HostError('the path is missing', 'invalid');
	}
	if (input.includes('\0')) throw new HostError('the path contains a NUL byte', 'invalid');
	const posix = input.replaceAll('\\', '/');
	if (!posix.startsWith('/')) throw new HostError('remote paths start with /', 'invalid');
	// Checked before collapsing, so `sub/../../etc` is refused outright instead of quietly
	// turning into `/etc` inside the share. riozeOS never sends one; anything that does is
	// either broken or trying something.
	const raw = posix.split('/');
	if (raw.includes('..')) {
		throw new HostError(`the path steps outside the shared folder: ${input}`, 'denied');
	}
	const collapsed = path.posix.normalize(posix);
	const clean = collapsed.replace(/\/+$/, '');
	return clean === '' ? '/' : clean;
}

/** The share's real location, resolved once per share path. */
export async function realShareRoot(share: ShareRecord): Promise<string> {
	const cached = realRoots.get(share.path);
	if (cached) return cached;
	let root: string;
	try {
		root = await realpath(share.path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
			throw new HostError(`the shared folder is gone: ${share.path}`, 'not-found');
		}
		throw error;
	}
	realRoots.set(share.path, root);
	return root;
}

/** Forgets a cached root — used when a share is removed or re-added. */
export function forgetShareRoot(sharePath: string): void {
	realRoots.delete(sharePath);
}

async function assertInside(root: string, target: string, remote: string): Promise<void> {
	let probe = target;
	for (;;) {
		try {
			const real = await realpath(probe);
			if (!isWithin(root, real)) {
				throw new HostError(`the path leaves the shared folder through a link: ${remote}`, 'denied');
			}
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
			const parent = path.dirname(probe);
			if (parent === probe) {
				throw new HostError(`the path is not inside the shared folder: ${remote}`, 'denied');
			}
			probe = parent;
		}
	}
}

export interface ResolvedSharePath {
	/** The normalized remote path, `/` included. */
	remote: string;
	/** The absolute host path. */
	abs: string;
}

export async function resolveSharePath(
	share: ShareRecord,
	remotePath: string
): Promise<ResolvedSharePath> {
	const remote = normalizeRemotePath(remotePath);
	const relative = remote === '/' ? '' : remote.slice(1);
	if (process.platform === 'win32' && relative.includes(':')) {
		throw new HostError(`the path is not valid on this host: ${remote}`, 'denied');
	}
	const root = await realShareRoot(share);
	const abs = path.resolve(root, relative);
	if (!isWithin(root, abs)) {
		throw new HostError(`the path steps outside the shared folder: ${remote}`, 'denied');
	}
	await assertInside(root, abs, remote);
	return { remote, abs };
}

/** Turns an absolute host path back into the remote form, when it is inside `root`. */
export function toRemotePath(root: string, abs: string): string | null {
	if (!isWithin(root, abs)) return null;
	const relative = path.relative(root, abs).split(path.sep).join('/');
	return relative ? `/${relative}` : '/';
}
