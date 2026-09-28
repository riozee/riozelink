/**
 * The filesystem half of the daemon.
 *
 * Every operation resolves through {@link resolveSharePath} first, then runs against `node:fs`.
 * Long files travel as chunks: a read hands back at most one {@link VFS_CHUNK} slice, and a write
 * lands in a hidden part file that only replaces the real one on the final slice. That is the same
 * trick a text editor uses, and it means an interrupted upload cannot leave a half file under the
 * name the user believes in.
 *
 * The part files are invisible to clients (`list` and `stat` filter them) and are removed when
 * the session that owned them goes away. A daemon crash can leave one behind; {@link sweepPartials}
 * cleans those up on the next start.
 */
import { appendFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { ShareRecord } from './config.ts';
import { HostError, requireNumber, requireString } from './errors.ts';
import type {
	RemoteEntry,
	VfsChangedEvent,
	VfsListReply,
	VfsReadReply,
	VfsSharesReply,
	VfsStatReply,
	VfsWriteReply
} from './protocol.ts';
import { VFS_CHUNK } from './protocol.ts';
import { fromBase64, randomId, toBase64 } from './util.ts';
import { realShareRoot, resolveSharePath, toRemotePath } from './sandbox.ts';

const PART_PREFIX = '.riozelink-part-';

function isPartFile(name: string): boolean {
	return name.includes(PART_PREFIX);
}

function entryOf(name: string, stats: Stats): RemoteEntry {
	return {
		name,
		kind: stats.isDirectory() ? 'dir' : 'file',
		size: stats.isDirectory() ? 0 : stats.size,
		mtime: Math.floor(stats.mtimeMs)
	};
}

export async function listShare(share: ShareRecord, remotePath: string): Promise<VfsListReply> {
	const { abs } = await resolveSharePath(share, remotePath);
	const names = await readdir(abs);
	const entries: RemoteEntry[] = [];
	for (const name of names) {
		if (isPartFile(name)) continue;
		try {
			entries.push(entryOf(name, await stat(path.join(abs, name))));
		} catch {
			// A file that vanished between the listing and the stat is simply not reported.
		}
	}
	entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
	return { entries };
}

export async function statShare(share: ShareRecord, remotePath: string): Promise<VfsStatReply> {
	const { remote, abs } = await resolveSharePath(share, remotePath);
	if (isPartFile(path.basename(abs))) return { entry: null };
	try {
		const stats = await stat(abs);
		const name = remote === '/' ? share.label : path.basename(abs);
		return { entry: entryOf(name, stats) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { entry: null };
		throw error;
	}
}

export async function readShare(
	share: ShareRecord,
	payload: Record<string, unknown>
): Promise<VfsReadReply> {
	const remote = requireString(payload.path, 'path');
	const offset = Math.max(0, Math.floor(requireNumber(payload.offset, 'offset')));
	const wanted = Math.max(1, Math.floor(requireNumber(payload.length, 'length')));
	const { abs } = await resolveSharePath(share, remote);

	let stats: Stats;
	try {
		stats = await stat(abs);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
			throw new HostError(`no such file: ${remote}`, 'not-found');
		}
		throw error;
	}
	if (!stats.isFile()) throw new HostError(`not a file: ${remote}`, 'invalid');

	const size = stats.size;
	if (size === 0 || offset >= size) {
		return { data: '', size, done: true };
	}
	const length = Math.min(wanted, VFS_CHUNK, size - offset);
	const handle = await open(abs, 'r');
	try {
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset);
		return {
			data: toBase64(buffer.subarray(0, bytesRead)),
			size,
			done: offset + bytesRead >= size
		};
	} finally {
		await handle.close();
	}
}

/** Everything one session has in flight. Owned by the session, never shared between clients. */
export interface PendingUpload {
	remote: string;
	abs: string;
	tmp: string;
	offset: number;
}

export type UploadTable = Map<string, PendingUpload>;

async function cancelUpload(table: UploadTable, remote: string): Promise<void> {
	const pending = table.get(remote);
	if (!pending) return;
	table.delete(remote);
	await rm(pending.tmp, { force: true }).catch(() => undefined);
}

/** Drops every part file a session was holding. Called when the session goes away. */
export async function cancelUploads(table: UploadTable): Promise<void> {
	for (const remote of [...table.keys()]) await cancelUpload(table, remote);
}

export async function writeShare(
	table: UploadTable,
	share: ShareRecord,
	payload: Record<string, unknown>
): Promise<VfsWriteReply> {
	const remote = requireString(payload.path, 'path');
	const offset = Math.floor(requireNumber(payload.offset, 'offset'));
	const data = typeof payload.data === 'string' ? fromBase64(payload.data) : null;
	if (!data) throw new HostError('invalid payload, data must be base64 text', 'invalid');
	const done = payload.done === true;
	const { abs } = await resolveSharePath(share, remote);

	let pending = table.get(remote);
	if (offset === 0) {
		await cancelUpload(table, remote);
		await mkdir(path.dirname(abs), { recursive: true });
		const tmp = path.join(path.dirname(abs), `${path.basename(abs)}${PART_PREFIX}${randomId()}`);
		await writeFile(tmp, data);
		pending = { remote, abs, tmp, offset: data.length };
		table.set(remote, pending);
	} else {
		if (!pending) {
			throw new HostError(`the write to ${remote} restarted; send the first slice again`, 'busy');
		}
		if (offset !== pending.offset) {
			throw new HostError(
				`the write to ${remote} arrived out of order (${offset} instead of ${pending.offset})`,
				'busy'
			);
		}
		await appendFile(pending.tmp, data);
		pending.offset += data.length;
	}

	if (!done) {
		return { received: pending.offset };
	}

	table.delete(remote);
	try {
		await rename(pending.tmp, abs);
	} catch (error) {
		await rm(pending.tmp, { force: true }).catch(() => undefined);
		throw error;
	}
	return { received: pending.offset };
}

export async function mkdirShare(share: ShareRecord, remote: string): Promise<void> {
	const { abs } = await resolveSharePath(share, remote);
	const existing = await stat(abs).catch(() => null);
	if (existing?.isFile()) throw new HostError(`there is a file there: ${remote}`, 'invalid');
	await mkdir(abs, { recursive: true });
}

export async function removeShare(share: ShareRecord, remote: string): Promise<void> {
	if (remote === '/') throw new HostError('the shared folder itself cannot be removed', 'denied');
	const { abs } = await resolveSharePath(share, remote);
	try {
		await rm(abs, { recursive: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
			throw new HostError(`no such file or folder: ${remote}`, 'not-found');
		}
		throw error;
	}
}

export async function renameShare(share: ShareRecord, from: string, to: string): Promise<void> {
	if (from === '/' || to === '/') throw new HostError('the shared folder itself cannot be moved', 'denied');
	const source = await resolveSharePath(share, from);
	const target = await resolveSharePath(share, to);
	const clash = await stat(target.abs).catch(() => null);
	if (clash) throw new HostError(`there is already something at ${to}`, 'exists');
	await mkdir(path.dirname(target.abs), { recursive: true });
	try {
		await rename(source.abs, target.abs);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
			throw new HostError(`no such file or folder: ${from}`, 'not-found');
		}
		throw error;
	}
}

/**
 * Watches every shared folder and reports what changed, batched.
 *
 * `fs.watch` cannot tell a create from a remove, so a `rename` event is answered with a `stat`:
 * the name exists now, so it appeared; it does not, so it is gone. A pure rename therefore shows
 * up as a removal and a creation, which is true from where the client sits.
 */
export class ShareWatcher {
	private watchers = new Map<string, FSWatcher>();
	private roots = new Map<string, string>();
	private batch = new Map<string, VfsChangedEvent>();
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly onBatch: (events: VfsChangedEvent[]) => void,
		private readonly onError: (message: string) => void
	) {}

	/** Re-syncs with the configured shares; called on start and whenever the list changes. */
	update(shares: Record<string, ShareRecord>): void {
		for (const [id, watcher] of this.watchers) {
			if (!shares[id] || this.roots.get(id) !== shares[id].path) {
				watcher.close();
				this.watchers.delete(id);
				this.roots.delete(id);
			}
		}
		for (const [id, share] of Object.entries(shares)) {
			if (this.watchers.has(id)) continue;
			this.watchShare(id, share);
		}
	}

	private watchShare(id: string, share: ShareRecord): void {
		try {
			const watcher = watch(share.path, { recursive: true }, (event, filename) => {
				if (!filename) return;
				const relative = filename.split(path.sep).join('/');
				if (isPartFile(relative)) return;
				this.queue(id, relative, event === 'change' ? 'modified' : 'touched');
			});
			watcher.on('error', (error) => this.onError(`watch on ${share.path}: ${error.message}`));
			this.watchers.set(id, watcher);
			this.roots.set(id, share.path);
		} catch (error) {
			this.onError(`cannot watch ${share.path}: ${(error as Error).message}`);
		}
	}

	private queue(shareId: string, relative: string, kind: VfsChangedEvent['kind'] | 'touched'): void {
		const remote = `/${relative}`;
		if (kind === 'touched') {
			const root = this.roots.get(shareId);
			void (async () => {
				const exists = root ? await stat(path.join(root, relative)).catch(() => null) : null;
				this.record(shareId, remote, exists ? 'created' : 'removed');
			})();
			return;
		}
		this.record(shareId, remote, kind);
	}

	private record(shareId: string, remote: string, kind: VfsChangedEvent['kind']): void {
		this.batch.set(`${kind}:${remote}`, { shareId, kind, path: remote });
		if (this.timer || this.flushScheduled()) return;
		this.timer = setTimeout(() => this.flush(), 250);
	}

	private flushScheduled(): boolean {
		if (this.batch.size >= 64) {
			this.flush();
			return true;
		}
		return false;
	}

	private flush(): void {
		this.timer = null;
		if (this.batch.size === 0) return;
		const events = [...this.batch.values()];
		this.batch.clear();
		this.onBatch(events);
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.batch.clear();
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
	}
}

/**
 * Part files left by a crash. Bounded on purpose: a few levels deep, a limited number of folders
 * visited, and only files older than an hour. It is housekeeping, not a full disk scan.
 */
export async function sweepPartials(shares: Record<string, ShareRecord>): Promise<number> {
	let removed = 0;
	for (const share of Object.values(shares)) {
		let root: string;
		try {
			root = await realShareRoot(share);
		} catch {
			continue;
		}
		const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
		let visited = 0;
		while (queue.length > 0 && visited < 2000) {
			const next = queue.shift() as { dir: string; depth: number };
			visited += 1;
			let names: string[];
			try {
				names = await readdir(next.dir);
			} catch {
				continue;
			}
			for (const name of names) {
				const abs = path.join(next.dir, name);
				if (isPartFile(name)) {
					const info = await stat(abs).catch(() => null);
					if (info && Date.now() - info.mtimeMs > 3600_000) {
						await rm(abs, { force: true }).catch(() => undefined);
						removed += 1;
					}
					continue;
				}
				if (next.depth < 4 && !name.startsWith('.')) {
					const info = await stat(abs).catch(() => null);
					if (info?.isDirectory()) queue.push({ dir: abs, depth: next.depth + 1 });
				}
			}
		}
	}
	return removed;
}

/** What `vfs:shares` answers with, and what a change to the list broadcasts. */
export function sharesReply(shares: Record<string, ShareRecord>): VfsSharesReply {
	return {
		shares: Object.entries(shares).map(([id, share]) => ({
			id,
			label: share.label,
			path: share.path
		}))
	};
}
