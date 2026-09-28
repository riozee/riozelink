/**
 * The terminal face of the daemon.
 *
 * On a TTY it paints a small live panel: where to point RiozeOS, the code it will ask for, who is
 * connected, which folders are shared, and the last few things that happened. `n` replaces the
 * code, `h` explains the first connection, `q` stops the daemon.
 *
 * Without a TTY (a service manager, a pipe, CI) it prints the panel once and then one line per
 * event, which is what a log file wants.
 */
import type { LogEntry, RiozeLinkHost } from './host.ts';
import { truncate } from './util.ts';

const ESC = '\x1b[';
const color = {
	reset: `${ESC}0m`,
	bold: `${ESC}1m`,
	dim: `${ESC}2m`,
	cyan: `${ESC}36m`,
	green: `${ESC}32m`,
	yellow: `${ESC}33m`,
	red: `${ESC}31m`
};

export interface DashboardOptions {
	onQuit?(): void;
	onLog?(entry: LogEntry): void;
}

export class Dashboard {
	private readonly useColor: boolean;
	private readonly tty: boolean;
	private timer: NodeJS.Timeout | null = null;
	private unsubscribe: (() => void) | null = null;
	private onKey: ((data: Buffer) => void) | null = null;
	private help = false;
	private streaming = false;
	private lastSeq = 0;
	private stopped = false;

	constructor(
		private readonly host: RiozeLinkHost,
		private readonly options: DashboardOptions = {}
	) {
		this.tty = Boolean(process.stdout.isTTY);
		this.useColor = this.tty && !process.env.NO_COLOR;
	}

	start(): void {
		if (this.tty) {
			process.stdout.write(`${ESC}2J${ESC}H`);
			this.unsubscribe = this.host.onUpdate(() => this.render());
			this.timer = setInterval(() => this.render(), 1000);
			this.timer.unref?.();
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(true);
				process.stdin.resume();
				this.onKey = (data: Buffer) => this.handleKey(data.toString('utf8'));
				process.stdin.on('data', this.onKey);
			}
			this.render();
			return;
		}
		this.printOnce();
		this.streaming = true;
		this.unsubscribe = this.host.onUpdate(() => this.streamLogs());
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.onKey) {
			process.stdin.off('data', this.onKey);
			this.onKey = null;
			if (process.stdin.isTTY) process.stdin.setRawMode(false);
			process.stdin.pause();
		}
		if (this.tty) process.stdout.write('\n');
	}

	private handleKey(key: string): void {
		if (key === 'q' || key === '\u0003' || key === '\u0004') {
			this.options.onQuit?.();
			return;
		}
		if (key === 'n') {
			this.host.rotatePairingCode();
			return;
		}
		if (key === 'h') {
			this.help = !this.help;
			this.render();
		}
	}

	private paint(text: string, tone: keyof typeof color): string {
		return this.useColor ? `${color[tone]}${text}${color.reset}` : text;
	}

	private render(): void {
		const width = process.stdout.columns ? process.stdout.columns - 1 : 100;
		const lines = this.buildLines().map((line) => truncate(line, width));
		process.stdout.write(`${ESC}H${ESC}J${lines.join('\n')}\n`);
	}

	private printOnce(): void {
		const lines = this.buildLines();
		process.stdout.write(`${lines.join('\n')}\n`);
		this.lastSeq = this.host.recentLogs(1)[0]?.seq ?? 0;
	}

	private streamLogs(): void {
		for (const entry of this.host.recentLogs(200)) {
			if (entry.seq <= this.lastSeq) continue;
			this.lastSeq = entry.seq;
			process.stdout.write(`${this.logLine(entry)}\n`);
			this.options.onLog?.(entry);
		}
	}

	private logLine(entry: LogEntry): string {
		const time = new Date(entry.at).toTimeString().slice(0, 8);
		const tone = entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'yellow' : 'dim';
		return `${this.paint(time, 'dim')}  ${this.paint(entry.message, tone)}`;
	}

	private buildLines(): string[] {
		const host = this.host;
		const clientCount = host.readyClients();
		const state = clientCount > 0 ? `${clientCount} connected` : 'no clients yet';
		const lines: string[] = [];

		lines.push(
			`${this.paint(`RIozeLink ${host.hostVersion}`, 'bold')} ${this.paint('· listening', 'green')}`
		);
		lines.push(`${this.paint('address  ', 'dim')} ${this.paint(host.address(), 'cyan')}`);
		lines.push(
			`${this.paint('code     ', 'dim')} ${this.paint(host.currentPairingCode(), 'bold')} ` +
				this.paint(`(${host.pairingRemainingLabel()} left)`, 'dim')
		);
		lines.push(`${this.paint('clients  ', 'dim')} ${state}`);
		const shares = Object.entries(host.shares());
		if (shares.length === 0) {
			lines.push(`${this.paint('shares   ', 'dim')} ${this.paint('none yet', 'dim')}`);
		}
		for (const [id, share] of shares) {
			lines.push(`${this.paint(`share    `, 'dim')} ${id} → ${share.path}`);
		}
		lines.push(`${this.paint('config   ', 'dim')} ${host.configDisplayPath()}`);
		lines.push('');

		if (this.help) {
			lines.push(this.paint('how to connect', 'bold'));
			lines.push(`  1. open riozeOS and start the RiozeLink app`);
			lines.push(`  2. paste the address and the code, or the whole pair link`);
			lines.push(`     ${truncate(host.pairingLink(), 96)}`);
			lines.push(`  3. the code retires itself the moment a client pairs`);
			lines.push('');
		}

		lines.push(this.paint('recent', 'bold'));
		const logs = host.recentLogs(this.help ? 4 : 8);
		if (logs.length === 0) lines.push(this.paint('  nothing yet', 'dim'));
		for (const entry of logs) lines.push(`  ${this.logLine(entry)}`);

		if (this.tty) {
			lines.push('');
			lines.push(this.paint('[n] new code   [h] help   [q] quit', 'dim'));
		}
		return lines;
	}
}
