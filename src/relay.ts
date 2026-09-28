/**
 * The relay, from this end.
 *
 * One link is one room. The daemon holds a link for the pairing room while a phrase is live, and
 * one more for every client it has paired with, so a returning RiozeOS can meet it without anybody
 * typing anything. A link reconnects on its own with a little backoff, and a lost relay connection
 * never touches the DataChannel that is already open: once two peers have met, the relay is done
 * with them.
 */
import type { RelayMessage, RelayRole, SignalPayload } from './protocol.ts';

export interface RelayLinkOptions {
	url: string;
	room: string;
	role: RelayRole;
	name?: string;
	onSignal(data: SignalPayload): void;
	/** The other member arrived or left. Worth a log line, never a disconnect. */
	onPeer?(event: 'joined' | 'left'): void;
	/** The join landed. */
	onReady?(): void;
	/** The socket dropped. A reconnect is already scheduled. */
	onLost?(reason: string): void;
	/** A fatal answer from the relay (a full room, a bad join). No retry follows. */
	onFatal?(reason: string): void;
	log(level: 'info' | 'warn' | 'error', message: string): void;
}

const HEARTBEAT_MS = 25_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class RelayLink {
	private socket: WebSocket | null = null;
	private stopped = false;
	private attempt = 0;
	private retryTimer: NodeJS.Timeout | null = null;
	private heartbeat: NodeJS.Timeout | null = null;
	private opened = false;

	constructor(private readonly options: RelayLinkOptions) {}

	get url(): string {
		return this.options.url;
	}

	get room(): string {
		return this.options.room;
	}

	/** Is the relay holding a socket for us right now? */
	get online(): boolean {
		return this.socket?.readyState === WebSocket.OPEN && this.opened;
	}

	connect(): void {
		if (this.stopped || this.socket) return;
		this.opened = false;
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.options.url);
		} catch (error) {
			this.scheduleRetry(`could not open ${this.options.url}: ${(error as Error).message}`);
			return;
		}
		this.socket = socket;

		socket.onopen = () => {
			this.attempt = 0;
			this.sendRaw({
				t: 'join',
				room: this.options.room,
				role: this.options.role,
				name: this.options.name
			});
			this.startHeartbeat();
		};
		socket.onmessage = (event) => this.handleMessage(event.data);
		socket.onerror = () => {
			// `onclose` always follows; cleanup lives there.
		};
		socket.onclose = (event) => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.stopHeartbeat();
			const wasOpen = this.opened;
			this.opened = false;
			if (wasOpen) this.options.onLost?.(`the relay connection closed (${event.code})`);
			if (!this.stopped) this.scheduleRetry(`the relay connection closed (${event.code})`);
		};
	}

	close(reason = 'closed'): void {
		this.stopped = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.stopHeartbeat();
		const socket = this.socket;
		this.socket = null;
		if (socket && socket.readyState <= WebSocket.OPEN) {
			try {
				socket.close(1000, reason);
			} catch {
				// Already gone.
			}
		}
	}

	/** Hands a signaling frame to the other member of the room. */
	send(data: SignalPayload): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
			this.options.log('warn', `nothing to send on — the link to ${this.options.url} is down`);
			return;
		}
		this.sendRaw({ t: 'signal', data });
	}

	private sendRaw(message: RelayMessage): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		try {
			this.socket.send(JSON.stringify(message));
		} catch (error) {
			this.options.log('warn', `relay send failed: ${(error as Error).message}`);
		}
	}

	private handleMessage(data: unknown): void {
		if (typeof data !== 'string') return; // The relay speaks text; anything else is not ours.
		let message: RelayMessage;
		try {
			message = JSON.parse(data) as RelayMessage;
		} catch {
			return;
		}
		if (!message || typeof message !== 'object') return;
		switch (message.t) {
			case 'joined':
				this.opened = true;
				this.options.onReady?.();
				return;
			case 'peer':
				this.options.onPeer?.(message.event);
				return;
			case 'signal':
				this.options.onSignal(message.data);
				return;
			case 'error':
				if (message.fatal) {
					this.options.log('error', `relay refused the join: ${message.reason}`);
					this.close('refused');
					this.options.onFatal?.(message.reason);
				} else {
					this.options.log('warn', `relay said: ${message.reason}`);
				}
				return;
			case 'ping':
				this.sendRaw({ t: 'pong' });
				return;
			default:
				return;
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeat = setInterval(() => this.sendRaw({ t: 'ping' }), HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
	}

	private scheduleRetry(reason: string): void {
		if (this.retryTimer || this.stopped) return;
		const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
		this.attempt = Math.min(this.attempt + 1, 6);
		const wait = delay + Math.floor(Math.random() * 500);
		this.options.log('info', `${reason}; trying again in ${(wait / 1000).toFixed(1)}s`);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.connect();
		}, wait);
		this.retryTimer.unref?.();
	}
}
