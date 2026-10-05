/**
 * The daemon updating itself.
 *
 * The check is demand-driven: a browser asks when it connects and the answer names what the
 * checkout is behind by, so the host never watches a timer. Applying is a sequence of small,
 * guarded steps — pull, dependencies, a type check — whose progress streams back over the link,
 * and the finish is the process replacing itself through `process.execve`, which keeps the same
 * PID and therefore the same terminal job, whether that terminal is a person's or a service
 * manager's.
 *
 * Nothing here touches another subsystem. The entry point hands in the `restart` callback, so a
 * test can watch an update run without the test runner becoming the updated program.
 */
import type { UpdateProgressEvent, UpdateState, UpdateStatusReply, UpdateStep } from './protocol.ts';

/** Every step but the last is child processes with a deadline. */
const STEP_TIMEOUT_MS = 120_000;
/** A fetch may be slower than a local command, but not much slower. */
const FETCH_TIMEOUT_MS = 30_000;
/** Two automatic checks inside a minute answer from what is already known. */
const CHECK_MIN_GAP_MS = 60_000;
/** The pause between the last event and the restart, so it can actually leave the machine. */
const RESTART_FLUSH_MS = 250;

export interface UpdateRunResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface UpdaterOptions {
	/** Where the daemon's own checkout lives. The real path is resolved from git. */
	repoDir: string;
	/** The branch the update follows. `main` unless a test says otherwise. */
	branch?: string;
	/** The command the dependency step runs. Tests hand in a stand-in; production uses Bun. */
	installCommand?: string[];
	/** The command the verification step runs. Tests hand in a stand-in too. */
	verifyCommand?: string[];
	log(level: 'info' | 'warn' | 'error', message: string): void;
	onStatus(status: UpdateStatusReply): void;
	onProgress(event: UpdateProgressEvent): void;
	/** Replaces the running process. `serve` hands in `process.execve`; tests hand in a spy. */
	restart(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The last non-empty line, which is where git and bun put the reason something failed. */
function lastLine(text: string): string {
	const lines = text
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.length > 0 ? lines[lines.length - 1] : '';
}

/**
 * What a daemon that cannot update itself answers with. Installing through a package manager is
 * a legitimate way to run this, so the check answers honestly and the app renders a note
 * instead of an error.
 */
export function unsupportedUpdateStatus(): UpdateStatusReply {
	return {
		supported: false,
		state: 'unknown',
		currentSha: null,
		branch: null,
		behind: 0,
		ahead: 0,
		remoteSha: null,
		remoteDate: null,
		remoteSubject: null,
		lastCheckAt: null,
		lastError: null,
		canApply: false,
		blockReason: null
	};
}

export class Updater {
	private readonly options: UpdaterOptions;
	private readonly installCommand: string[];
	private readonly verifyCommand: string[];
	private repoDir: string;
	private readonly branch: string;
	private supported = false;
	private state: UpdateState = 'unknown';
	private checked = false;
	private currentSha: string | null = null;
	private branchName: string | null = null;
	private behind = 0;
	private ahead = 0;
	private remoteSha: string | null = null;
	private remoteDate: number | null = null;
	private remoteSubject: string | null = null;
	private lastCheckAt: number | null = null;
	private lastError: string | null = null;
	private canApply = false;
	private blockReason: string | null = null;
	private dirty = false;
	private checking: Promise<UpdateStatusReply> | null = null;
	private applying = false;

	constructor(options: UpdaterOptions) {
		this.options = options;
		this.repoDir = options.repoDir;
		this.branch = options.branch ?? 'main';
		this.installCommand = options.installCommand ?? [
			process.execPath,
			'install',
			'--frozen-lockfile'
		];
		this.verifyCommand = options.verifyCommand ?? [process.execPath, 'run', 'check'];
	}

	/** Resolves what the checkout is. The answer never changes while the process lives. */
	async init(): Promise<void> {
		const probe = await this.run(['git', 'rev-parse', '--show-toplevel'], this.repoDir, 15_000);
		if (probe.code !== 0) {
			this.supported = false;
			this.state = 'unknown';
			return;
		}
		const top = probe.stdout.trim();
		if (top) this.repoDir = top;
		this.supported = true;
		this.currentSha = await this.readSha();
		this.branchName = await this.readBranch();
		this.deriveAvailability();
	}

	status(): UpdateStatusReply {
		return {
			supported: this.supported,
			state: this.state,
			currentSha: this.currentSha,
			branch: this.branchName,
			behind: this.behind,
			ahead: this.ahead,
			remoteSha: this.remoteSha,
			remoteDate: this.remoteDate,
			remoteSubject: this.remoteSubject,
			lastCheckAt: this.lastCheckAt,
			lastError: this.lastError,
			canApply: this.canApply,
			blockReason: this.blockReason
		};
	}

	/**
	 * Fetches and compares. A check already in flight is joined, one that finished inside a minute
	 * answers from what is known, and `force` skips that gap — which is what the buttons press.
	 */
	async check(force = false): Promise<UpdateStatusReply> {
		if (!this.supported || this.applying) return this.status();
		if (this.checking) return this.checking;
		if (!force && this.lastCheckAt !== null && Date.now() - this.lastCheckAt < CHECK_MIN_GAP_MS) {
			return this.status();
		}
		this.state = 'checking';
		this.emitStatus();
		this.checking = this.runCheck().finally(() => {
			this.checking = null;
		});
		return this.checking;
	}

	/**
	 * Pull, install when the lock moved, verify, restart. Resolves only when the handover did not
	 * happen: a successful finish replaces this process and never comes back here.
	 */
	async apply(): Promise<void> {
		if (this.applying || !this.canApply || this.behind === 0) return;
		this.applying = true;
		this.state = 'applying';
		this.lastError = null;
		this.blockReason = null;
		this.emitStatus();
		const previous = this.currentSha ?? (await this.readSha()) ?? '';
		try {
			if (!(await this.stepPull())) return;
			const deps = await this.stepDependencies(previous);
			if (!deps.ok) return;
			if (!(await this.stepVerify(previous, deps.installed))) return;

			// The code is on disk and checked. Everything from here on is the handover.
			this.behind = 0;
			this.ahead = 0;
			this.canApply = false;
			this.blockReason = null;
			this.state = 'restarting';
			this.emitStatus();
			this.progress('restart', 'start', `restarting on ${this.currentSha ?? 'the new version'}`);
			// One beat, so the last event can leave the machine before the link goes down with it.
			await sleep(RESTART_FLUSH_MS);
			await this.options.restart();
			// Only reached when the process was not actually replaced.
			this.state = 'idle';
			this.lastError =
				'the update is applied, but this daemon could not restart itself. Restart it to load the new version';
			this.emitStatus();
			this.options.log('warn', this.lastError);
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			this.options.log('error', `update failed: ${this.lastError}`);
			this.deriveAvailability();
			this.emitStatus();
		} finally {
			this.applying = false;
		}
	}

	/* ------------------------------------------------------------------- checks ------- */

	private async runCheck(): Promise<UpdateStatusReply> {
		const fetched = await this.run(
			['git', 'fetch', '--quiet', 'origin', this.branch],
			this.repoDir,
			FETCH_TIMEOUT_MS
		);
		if (fetched.code !== 0) {
			this.lastCheckAt = Date.now();
			this.lastError = fetched.timedOut
				? 'the git fetch timed out'
				: `git fetch failed (${lastLine(fetched.stderr) || 'no output'})`;
			this.deriveAvailability();
			this.emitStatus();
			this.options.log('warn', `update check failed: ${this.lastError}`);
			return this.status();
		}
		this.currentSha = await this.readSha();
		this.branchName = await this.readBranch();
		this.behind = await this.readCount(`HEAD..origin/${this.branch}`);
		this.ahead = await this.readCount(`origin/${this.branch}..HEAD`);
		this.remoteSha = await this.readRev(`origin/${this.branch}`);
		const meta = await this.git(['log', '-1', '--format=%ct%n%s', `origin/${this.branch}`]);
		if (meta.code === 0) {
			const [seconds, ...subject] = meta.stdout.trim().split('\n');
			const when = Number(seconds);
			this.remoteDate = Number.isFinite(when) && when > 0 ? when * 1000 : null;
			this.remoteSubject = subject.join(' ').trim() || null;
		}
		const dirty = await this.git(['status', '--porcelain']);
		this.dirty = dirty.code === 0 && dirty.stdout.trim().length > 0;
		this.checked = true;
		this.lastCheckAt = Date.now();
		this.lastError = null;
		this.deriveAvailability();
		this.emitStatus();
		return this.status();
	}

	private deriveAvailability(): void {
		this.canApply = false;
		this.blockReason = null;
		if (!this.supported) {
			this.state = 'unknown';
			return;
		}
		if (this.behind === 0) {
			this.state = this.checked ? 'idle' : 'unknown';
			return;
		}
		this.state = 'available';
		const execve = (process as unknown as { execve?: unknown }).execve;
		if (typeof execve !== 'function') {
			this.blockReason = 'this Bun version cannot restart the daemon in place, so it cannot update itself';
		} else if (this.ahead > 0) {
			this.blockReason = `this checkout has commits that are not on origin/${this.branch}`;
		} else if (this.branchName !== this.branch) {
			this.blockReason =
				this.branchName === 'HEAD'
					? 'this checkout is not on a branch'
					: `this checkout is on ${this.branchName}, not ${this.branch}`;
		} else if (this.dirty) {
			this.blockReason = 'the checkout has local changes';
		} else {
			this.canApply = true;
		}
	}

	/* -------------------------------------------------------------------- steps ------- */

	private async stepPull(): Promise<boolean> {
		this.progress('pull', 'start', `pulling origin/${this.branch}`);
		const pull = await this.git(['pull', '--ff-only', 'origin', this.branch], STEP_TIMEOUT_MS);
		if (pull.code !== 0) {
			this.failStep(
				'pull',
				pull.timedOut ? 'the pull timed out' : lastLine(pull.stderr) || 'the pull failed'
			);
			return false;
		}
		this.currentSha = (await this.readSha()) ?? this.currentSha;
		this.progress('pull', 'done', `now at ${this.currentSha ?? 'the new version'}`);
		return true;
	}

	private async stepDependencies(previous: string): Promise<{ ok: boolean; installed: boolean }> {
		const changed = await this.git([
			'diff',
			'--name-only',
			previous,
			'HEAD',
			'--',
			'bun.lock',
			'package.json'
		]);
		const needed = changed.code === 0 && changed.stdout.trim().length > 0;
		if (!needed) {
			this.progress('deps', 'start', 'no dependency changes');
			this.progress('deps', 'done', 'no dependency changes');
			return { ok: true, installed: false };
		}
		this.progress('deps', 'start', 'installing dependencies');
		const install = await this.run(this.installCommand, this.repoDir, STEP_TIMEOUT_MS);
		if (install.code !== 0) {
			await this.revert(previous, true);
			this.failStep(
				'deps',
				install.timedOut
					? 'installing dependencies timed out'
					: lastLine(install.stderr) || 'installing dependencies failed'
			);
			return { ok: false, installed: false };
		}
		this.progress('deps', 'done', 'dependencies installed');
		return { ok: true, installed: true };
	}

	private async stepVerify(previous: string, installed: boolean): Promise<boolean> {
		this.progress('verify', 'start', 'running the type check');
		const verify = await this.run(this.verifyCommand, this.repoDir, STEP_TIMEOUT_MS);
		if (verify.code !== 0) {
			await this.revert(previous, installed);
			// `bun run` wraps a failed script in one unhelpful stderr line, so the tail of the
			// script's own output is what goes to the log. The status keeps the plain answer.
			const detail = lastLine(verify.stdout) || lastLine(verify.stderr);
			if (detail) this.options.log('warn', `the type check said: ${detail}`);
			this.failStep('verify', verify.timedOut ? 'the type check timed out' : 'the type check failed');
			return false;
		}
		this.progress('verify', 'done', 'the type check passed');
		return true;
	}

	/** Puts the checkout back where it was. The pull never goes past a step that failed. */
	private async revert(previous: string, restoreDeps: boolean): Promise<void> {
		this.options.log('warn', `reverting to ${previous}`);
		const reset = await this.git(['reset', '--hard', previous], STEP_TIMEOUT_MS);
		if (reset.code !== 0) {
			this.options.log('error', `could not revert the checkout: ${lastLine(reset.stderr) || 'no output'}`);
		}
		if (restoreDeps) {
			const restore = await this.run(this.installCommand, this.repoDir, STEP_TIMEOUT_MS);
			if (restore.code !== 0) {
				this.options.log(
					'error',
					`could not restore dependencies: ${lastLine(restore.stderr) || 'no output'}`
				);
			}
		}
		this.currentSha = previous;
	}

	private failStep(step: UpdateStep, message: string): void {
		this.progress(step, 'failed', message);
		this.lastError = message;
		this.deriveAvailability();
		this.emitStatus();
		this.options.log('warn', `update stopped: ${message}`);
	}

	/* ----------------------------------------------------------------- plumbing ------- */

	private async readSha(): Promise<string | null> {
		const result = await this.git(['rev-parse', '--short=7', 'HEAD']);
		return result.code === 0 ? result.stdout.trim() || null : null;
	}

	private async readBranch(): Promise<string | null> {
		const result = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
		return result.code === 0 ? result.stdout.trim() || null : null;
	}

	private async readCount(range: string): Promise<number> {
		const result = await this.git(['rev-list', '--count', range]);
		const value = Number.parseInt(result.stdout.trim(), 10);
		return Number.isFinite(value) ? value : 0;
	}

	private async readRev(ref: string): Promise<string | null> {
		const result = await this.git(['rev-parse', '--short=7', ref]);
		return result.code === 0 ? result.stdout.trim() || null : null;
	}

	private git(args: string[], timeoutMs = 30_000): Promise<UpdateRunResult> {
		return this.run(['git', ...args], this.repoDir, timeoutMs);
	}

	private async run(cmd: string[], cwd: string, timeoutMs: number): Promise<UpdateRunResult> {
		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn({ cmd, cwd, stdout: 'pipe', stderr: 'pipe', env: process.env });
		} catch (error) {
			return {
				code: -1,
				stdout: '',
				stderr: error instanceof Error ? error.message : String(error),
				timedOut: false
			};
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill('SIGKILL');
			} catch {
				// Already gone.
			}
		}, timeoutMs);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout as ReadableStream).text(),
			new Response(proc.stderr as ReadableStream).text()
		]);
		const code = await proc.exited;
		clearTimeout(timer);
		return { code: timedOut ? -1 : code, stdout, stderr, timedOut };
	}

	private progress(step: UpdateStep, state: 'start' | 'done' | 'failed', message: string): void {
		this.options.onProgress({ step, state, message });
		if (state === 'failed') this.options.log('warn', `update: ${message}`);
		else if (state === 'start') this.options.log('info', `update: ${message}`);
	}

	private emitStatus(): void {
		this.options.onStatus(this.status());
	}
}
