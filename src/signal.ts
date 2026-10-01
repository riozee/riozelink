/**
 * One room on the relay.
 *
 * A link owns one room and one socket in it. The relay forwards whatever this end sends to the other
 * clients in the room and nothing else. It keeps no account of who is present, it answers nothing,
 * and it never speaks first, so a link is a way to exchange introductions and little more. Once two
 * ends have their DataChannel the relay is done with them.
 *
 * A link reconnects on its own with a little backoff, and a lost socket never touches a DataChannel
 * that is already open.
 */
import {
	fitsRelayFrame,
	makePeerId,
	PING_FRAME,
	PONG_FRAME,
	PROTOCOL_VERSION,
	signalSocketUrl,
	SIGNAL_SUBPROTOCOL,
	type RelayMessage,
	type RelayOutgoing
} from './protocol.ts';

export interface SignalLinkOptions {
	/** The relay host. */
	base: string;
	/** The room this link sits in. */
	room: string;
	/** A message arrived from the room. `from` is the other end's own id. */
	onMessage(message: RelayMessage, from: string): void;
	/** The socket opened and the room was joined. */
	onOpen?(): void;
	/** The socket dropped. A reconnect is already scheduled. */
	onLost?(reason: string): void;
	log(level: 'info' | 'warn' | 'error', message: string): void;
}

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
/**
 * The heartbeat is the only way this end can tell a quiet room from a lost line. A room says
 * nothing for hours, so a line killed by a sleeping machine or a router's idle timeout looks
 * perfectly connected: no FIN, no error, and every message sent into it is simply lost. The relay
 * answers the probe at its own edge, which is what makes asking this often affordable. Asleep or
 * awake, the answer that never comes is the one honest signal there is.
 */
/** How often the line is asked whether it is still there. */
const PING_INTERVAL_MS = 15_000;
/** How long an answer is given before the line is taken for lost. */
const PONG_TIMEOUT_MS = 5_000;

/** What a close code means, in words a log reader can act on. */
function closeReason(code: number): string {
	if (code === 1009) return 'a frame went over the relay limit, so it closed the socket';
	if (code === 1000) return 'the relay closed the socket';
	if (code === 1006) return 'the relay socket dropped';
	return `the relay socket closed (${code})`;
}

export class SignalLink {
	/** The room this link sits in. */
	readonly room: string;
	/**
	 * This end's own id, which is what the other end addresses its replies to. The relay assigns
	 * nothing, so this is ours to pick, and it stays the same for the life of the link so a browser
	 * that reconnects still knows who it is talking to.
	 */
	readonly id = makePeerId('rz-h');

	private socket: WebSocket | null = null;
	private stopped = false;
	private joined = false;
	private attempt = 0;
	private retryTimer: NodeJS.Timeout | null = null;
	private pingTimer: NodeJS.Timeout | null = null;
	/** The deadline for the answer to the ping that is outstanding, while one is. */
	private pongDeadline: NodeJS.Timeout | null = null;

	constructor(private readonly options: SignalLinkOptions) {
		this.room = options.room;
	}

	get online(): boolean {
		return this.socket?.readyState === WebSocket.OPEN && this.joined;
	}

	get retrying(): boolean {
		return this.retryTimer !== null;
	}

	connect(): void {
		if (this.stopped || this.socket) return;
		this.joined = false;
		let socket: WebSocket;
		try {
			socket = new WebSocket(signalSocketUrl(this.options.base, this.room), [SIGNAL_SUBPROTOCOL]);
		} catch (error) {
			this.scheduleRetry(`could not open ${this.options.base}: ${(error as Error).message}`);
			return;
		}
		this.socket = socket;

		socket.onopen = () => {
			this.joined = true;
			this.attempt = 0;
			// The relay never speaks first, so saying hello is the only way to announce this end. The
			// host is the answering side, so it says hello and then waits.
			this.send({ type: 'hello', protocol: PROTOCOL_VERSION });
			this.options.onOpen?.();
			this.armHeartbeat();
		};
		socket.onmessage = (event) => this.handleMessage(event.data);
		socket.onerror = () => {
			// `onclose` always follows; cleanup lives there.
		};
		socket.onclose = (event) => {
			if (this.socket !== socket) return;
			const wasJoined = this.joined;
			this.socket = null;
			this.joined = false;
			this.clearHeartbeat();
			const reason = closeReason(event.code);
			if (wasJoined) this.options.onLost?.(reason);
			if (!this.stopped) this.scheduleRetry(reason);
		};
	}

	close(reason = 'closed'): void {
		this.stopped = true;
		this.clearHeartbeat();
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.dropSocket(reason);
	}

	/** Sends one message to the room. The socket fills in the room, the sender and the clock. */
	send(message: RelayOutgoing): void {
		this.sendRaw({ ...message, room: this.room, from: this.id, ts: Date.now() });
	}

	/**
	 * One frame exactly as written, for the heartbeat the relay matches verbatim. A room message
	 * carries the room, the sender and the clock, and any of those would stop it being a ping.
	 */
	private sendExact(text: string): void {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return;
		try {
			socket.send(text);
		} catch (error) {
			this.options.log('warn', `relay send failed: ${(error as Error).message}`);
		}
	}

	/** Tells the room this end is leaving. Best effort: the socket may already be gone. */
	leave(): void {
		this.send({ type: 'bye' });
	}

	private sendRaw(message: RelayMessage): void {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return;
		const text = JSON.stringify(message);
		// The relay answers an oversized frame by closing the socket with 1009, which would take the
		// whole room down over one bad message. Better to drop the frame and say so.
		if (!fitsRelayFrame(text)) {
			this.options.log(
				'error',
				`a ${message.type} frame was over the relay's 64 KiB limit, so it was not sent`
			);
			return;
		}
		try {
			socket.send(text);
		} catch (error) {
			this.options.log('warn', `relay send failed: ${(error as Error).message}`);
		}
	}

	private handleMessage(data: unknown): void {
		// The relay forwards text and drops binary, so anything else is somebody else's protocol.
		if (typeof data !== 'string') return;
		// The relay's own answer to this link's heartbeat. It is the one frame a room never sees, and
		// it stops here rather than being handed up as a room message.
		if (data === PONG_FRAME) {
			this.clearPong();
			return;
		}
		let message: RelayMessage;
		try {
			message = JSON.parse(data) as RelayMessage;
		} catch {
			return;
		}
		if (!message || typeof message.type !== 'string' || typeof message.from !== 'string') return;
		// The relay does not echo, but a room can hold more than two ends and this is cheap.
		if (message.from === this.id) return;
		if (message.to && message.to !== this.id) return;
		this.options.onMessage(message, message.from);
	}

	private dropSocket(reason: string): void {
		const socket = this.socket;
		this.socket = null;
		this.joined = false;
		if (socket && socket.readyState <= WebSocket.OPEN) {
			try {
				socket.close(1000, reason);
			} catch {
				// Already gone.
			}
		}
	}

	private scheduleRetry(reason: string): void {
		if (this.retryTimer || this.stopped) return;
		const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
		this.attempt = Math.min(this.attempt + 1, 6);
		const wait = delay + Math.floor(Math.random() * 500);
		this.options.log('info', `${reason}. Trying the room again in ${(wait / 1000).toFixed(1)}s`);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.connect();
		}, wait);
		this.retryTimer.unref?.();
	}

	/**
	 * Asks the relay whether the line is still there, and takes silence for an answer.
	 *
	 * The probe is cheap because the edge answers it, so a lost line is found in seconds instead of
	 * lasting until something restarts, which is the whole difference between a room that recovers
	 * while a browser is knocking and a room that stays dark through every knock.
	 */
	private armHeartbeat(): void {
		this.clearHeartbeat();
		this.pingTimer = setInterval(() => {
			if (this.stopped || this.socket === null || this.pongDeadline) return;
			this.sendExact(PING_FRAME);
			this.pongDeadline = setTimeout(() => {
				this.pongDeadline = null;
				// A line that answers nothing is one this end cannot use, and no close frame is coming
				// to say so. The socket is dropped first so its own close handler does not read as a lost
				// room and schedule a second retry on top of this one.
				this.dropSocket('the relay stopped answering');
				this.scheduleRetry('the relay stopped answering');
			}, PONG_TIMEOUT_MS);
			this.pongDeadline.unref?.();
		}, PING_INTERVAL_MS);
		this.pingTimer.unref?.();
	}

	private clearPong(): void {
		if (this.pongDeadline) clearTimeout(this.pongDeadline);
		this.pongDeadline = null;
	}

	private clearHeartbeat(): void {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = null;
		this.clearPong();
	}
}
