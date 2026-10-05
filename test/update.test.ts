/**
 * The updater against real git repositories in a temp directory: a bare origin, a seed clone
 * that pushes to it, and a work clone that is the daemon's checkout. Nothing here touches the
 * network, and the restart is a spy, so a test run never becomes the updated program.
 */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UpdateProgressEvent } from '../src/protocol.ts';
import { Updater } from '../src/update.ts';

const COMMIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 'RiozeLink Test',
	GIT_AUTHOR_EMAIL: 'test@riozelink.invalid',
	GIT_COMMITTER_NAME: 'RiozeLink Test',
	GIT_COMMITTER_EMAIL: 'test@riozelink.invalid'
};

async function git(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn({
		cmd: ['git', ...args],
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: COMMIT_ENV
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text()
	]);
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
	}
	return stdout;
}

interface Fixture {
	root: string;
	/** The daemon's checkout. */
	work: string;
	/** Where new commits are made and pushed from. */
	seed: string;
	cleanup(): Promise<void>;
}

/**
 * The check command fails exactly when the file says `bad`, so a commit can pass or fail the
 * verification step without touching anything else. The updater's dependency and verification
 * commands are swapped for these stand-ins, so a test run never spawns Bun on Bun's behalf.
 */
async function makeFixture(): Promise<Fixture> {
	const root = await mkdtemp(path.join(tmpdir(), 'riozelink-update-'));
	const origin = path.join(root, 'origin.git');
	const seed = path.join(root, 'seed');
	const work = path.join(root, 'work');
	await git(root, 'init', '--bare', '--initial-branch=main', origin);
	await mkdir(seed, { recursive: true });
	await git(seed, 'init', '--initial-branch=main');
	await writeFile(path.join(seed, 'file.txt'), 'one\n');
	await git(seed, 'add', '.');
	await git(seed, 'commit', '-m', 'first');
	await git(seed, 'remote', 'add', 'origin', origin);
	await git(seed, 'push', '-u', 'origin', 'main');
	await git(root, 'clone', origin, work);
	return {
		root,
		work,
		seed,
		cleanup: () => rm(root, { recursive: true, force: true })
	};
}

/** Commits `file` in the seed clone and pushes it, returning the short sha. */
async function pushCommit(
	fixture: Fixture,
	file: string,
	content: string,
	message: string
): Promise<string> {
	await writeFile(path.join(fixture.seed, file), content);
	await git(fixture.seed, 'add', file);
	await git(fixture.seed, 'commit', '-m', message);
	await git(fixture.seed, 'push', 'origin', 'main');
	return (await git(fixture.seed, 'rev-parse', '--short=7', 'HEAD')).trim();
}

function makeUpdater(fixture: Fixture, hooks: {
	events?: UpdateProgressEvent[];
	onRestart?: () => void;
} = {}): Updater {
	return new Updater({
		repoDir: fixture.work,
		installCommand: ['true'],
		verifyCommand: ['grep', '-v', 'bad', 'file.txt'],
		log: () => undefined,
		onStatus: () => undefined,
		onProgress: (event) => hooks.events?.push(event),
		restart: async () => {
			hooks.onRestart?.();
		}
	});
}

test('a checkout behind the remote is offered an update', async () => {
	const fixture = await makeFixture();
	try {
		const remote = await pushCommit(fixture, 'file.txt', 'two\n', 'second');
		const updater = makeUpdater(fixture);
		await updater.init();
		const first = await updater.check(true);
		expect(first.supported).toBe(true);
		expect(first.state).toBe('available');
		expect(first.behind).toBe(1);
		expect(first.ahead).toBe(0);
		expect(first.remoteSha).toBe(remote);
		expect(first.remoteSubject).toBe('second');
		expect(first.canApply).toBe(true);
		expect(first.blockReason).toBeNull();
		// A second automatic check inside the minute answers from what is already known.
		const second = await updater.check(false);
		expect(second.lastCheckAt).toBe(first.lastCheckAt);
	} finally {
		await fixture.cleanup();
	}
});

test('applying pulls the commit, runs the steps and asks for the restart', async () => {
	const fixture = await makeFixture();
	try {
		const remote = await pushCommit(fixture, 'file.txt', 'two\n', 'second');
		const events: UpdateProgressEvent[] = [];
		let restarts = 0;
		const updater = makeUpdater(fixture, { events, onRestart: () => (restarts += 1) });
		await updater.init();
		const checked = await updater.check(true);
		expect(checked.canApply).toBe(true);
		await updater.apply();
		expect(restarts).toBe(1);
		expect((await git(fixture.work, 'rev-parse', '--short=7', 'HEAD')).trim()).toBe(remote);
		expect([...new Set(events.map((event) => event.step))]).toEqual([
			'pull',
			'deps',
			'verify',
			'restart'
		]);
		expect(events.every((event) => event.state !== 'failed')).toBe(true);
		const after = updater.status();
		expect(after.state).toBe('idle');
		expect(after.behind).toBe(0);
		expect(after.canApply).toBe(false);
	} finally {
		await fixture.cleanup();
	}
});

test('a dirty checkout is offered the update but not allowed to take it', async () => {
	const fixture = await makeFixture();
	try {
		await pushCommit(fixture, 'file.txt', 'two\n', 'second');
		await writeFile(path.join(fixture.work, 'file.txt'), 'a local edit\n');
		const updater = makeUpdater(fixture);
		await updater.init();
		const status = await updater.check(true);
		expect(status.state).toBe('available');
		expect(status.behind).toBe(1);
		expect(status.canApply).toBe(false);
		expect(status.blockReason).toContain('local changes');
		// The guard is what apply obeys as well.
		await updater.apply();
		expect((await git(fixture.work, 'rev-parse', '--short=7', 'HEAD')).trim()).not.toBe(
			status.remoteSha
		);
	} finally {
		await fixture.cleanup();
	}
});

test('a failing type check is reverted and nothing restarts', async () => {
	const fixture = await makeFixture();
	try {
		await pushCommit(fixture, 'file.txt', 'bad\n', 'a commit the check refuses');
		const before = (await git(fixture.work, 'rev-parse', '--short=7', 'HEAD')).trim();
		const events: UpdateProgressEvent[] = [];
		let restarts = 0;
		const updater = makeUpdater(fixture, { events, onRestart: () => (restarts += 1) });
		await updater.init();
		await updater.check(true);
		await updater.apply();
		expect(restarts).toBe(0);
		expect((await git(fixture.work, 'rev-parse', '--short=7', 'HEAD')).trim()).toBe(before);
		expect(events.some((event) => event.step === 'verify' && event.state === 'failed')).toBe(true);
		const status = updater.status();
		expect(status.state).toBe('available');
		expect(status.lastError).toContain('type check');
		expect(status.canApply).toBe(true);
	} finally {
		await fixture.cleanup();
	}
});

test('a directory that is not a checkout reports itself unsupported', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'riozelink-plain-'));
	try {
		const updater = new Updater({
			repoDir: dir,
			log: () => undefined,
			onStatus: () => undefined,
			onProgress: () => undefined,
			restart: async () => undefined
		});
		await updater.init();
		const status = await updater.check(true);
		expect(status.supported).toBe(false);
		expect(status.state).toBe('unknown');
		expect(status.canApply).toBe(false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
