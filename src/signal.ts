/**
 * One registration with a signaling server.
 *
 * A link owns one peer id: the daemon keeps one for the pairing phrase and one for every browser it
 * has paired with. The server (the public PeerServer by default, or your own on a URL you choose)
 * remembers that the id is here and forwards OFFER, ANSWER and CANDIDATE frames addressed to it.
 *
 * A link reconnects on its own with a little backoff, and a lost signaling connection never touches
 * a DataChannel that is already open: once two peers have met, the server is done with them.
 */
import {
	makeConnectionId,
	offerPayload,
	signalSocketUrl,
	type SignalMessage,
	type SignalPayload
} from './protocol.ts';

export interface SignalLinkOptions {
	/** `wss://…/peerjs`. */
	base: string;
	/** The id this link registers. Valid PeerServer ids only: letters, digits, `-` and `_`. */
	id: string;
	/** A frame arrived for us. `from` is the id it came from. */
	onSignal(payload: SignalPayload, from: string): void;
	/** The other end said goodbye, or its offer went unanswered. */
	onPeerLeft?(from: string): void;
	/** The registration landed. */
	onOpen?(): void;
	/** The socket dropped. A reconnect is already scheduled. */
	onLost?(reason: string): void;
	/** The id is taken: another process is already using it. */
	onTaken?(): void;
	log(level: 'info' | 'warn' | 'error', message: string): void;
}

/** How often we tell the server we are still here. PeerServer drops silent peers. */
const HEARTBEAT_MS = 5000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export class SignalLink {
	readonly id: string;
	/** The peer we are mid-conversation with. Set by an inbound offer or by `offer()`. */
	remoteId: string | null = null;
	/** Tells this link's frames apart from another one's inside the same socket. */
	readonly connectionId = makeConnectionId();
	/**
	 * The connection id the other end offered with. Answers and candidates carry it back, the way the
	 * peerjs library does it, so both ends can tell one attempt from the next.
	 */
	private remoteConnectionId: string | null = null;

	private socket: WebSocket | null = null;
	private stopped = false;
	private registered = false;
	private attempt = 0;
	private retryTimer: NodeJS.Timeout | null = null;
	private heartbeat: NodeJS.Timeout | null = null;

	constructor(private readonly options: SignalLinkOptions) {
		this.id = options.id;
	}

	get online(): boolean {
		return this.socket?.readyState === WebSocket.OPEN && this.registered;
	}

	get retrying(): boolean {
		return this.retryTimer !== null;
	}

	connect(): void {
		if (this.stopped || this.socket) return;
		this.registered = false;
		let socket: WebSocket;
		try {
			socket = new WebSocket(signalSocketUrl(this.options.base, this.id, String(Math.random())));
		} catch (error) {
			this.scheduleRetry(`could not open ${this.options.base}: ${(error as Error).message}`);
			return;
		}
		this.socket = socket;

		socket.onopen = () => {
			this.startHeartbeat();
		};
		socket.onmessage = (event) => this.handleMessage(event.data);
		socket.onerror = () => {
			// `onclose` always follows; cleanup lives there.
		};
		socket.onclose = (event) => {
			if (this.socket !== socket) return;
			const wasOpen = this.registered;
			this.socket = null;
			this.registered = false;
			this.stopHeartbeat();
			if (wasOpen) this.options.onLost?.(`the signaling connection closed (${event.code})`);
			if (!this.stopped) this.scheduleRetry(`the signaling connection closed (${event.code})`);
		};
	}

	close(reason = 'closed'): void {
		this.stopped = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.stopHeartbeat();
		this.dropSocket(reason);
	}

	/** Sends the offer for this link's id. The browser end calls this. */
	offer(dst: string, sdp: string): void {
		this.remoteId = dst;
		this.send(offerPayload(sdp));
	}

	/** Sends whatever the peer asked for: an answer, or a candidate. */
	send(payload: SignalPayload): void {
		if (!this.remoteId) {
			this.options.log('warn', 'nothing to send to — no peer has knocked yet');
			return;
		}
		const dst = this.remoteId;
		const type =
			'sdp' in payload ? (payload.sdp.type === 'offer' ? 'OFFER' : 'ANSWER') : 'CANDIDATE';
		this.sendRaw({
			type,
			dst,
			payload: {
				...payload,
				connectionId: payload.connectionId ?? this.remoteConnectionId ?? this.connectionId
			}
		});
	}

	/** Tells the other end this link is over. Best effort: it may already be gone. */
	leave(): void {
		if (!this.remoteId) return;
		this.sendRaw({ type: 'LEAVE', dst: this.remoteId });
		this.remoteId = null;
	}

	private sendRaw(message: SignalMessage): void {
		if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
		try {
			this.socket.send(JSON.stringify(message));
		} catch (error) {
			this.options.log('warn', `signaling send failed: ${(error as Error).message}`);
		}
	}

	private handleMessage(data: unknown): void {
		if (typeof data !== 'string') return;
		let message: SignalMessage;
		try {
			message = JSON.parse(data) as SignalMessage;
		} catch {
			return;
		}
		switch (message.type) {
			case 'OPEN':
				this.attempt = 0;
				this.registered = true;
				this.options.onOpen?.();
				return;
			case 'ID-TAKEN':
				this.options.log(
					'error',
					`the signaling server already knows a peer with the id ${this.id}`
				);
				this.options.onTaken?.();
				this.close('id taken');
				return;
			case 'INVALID-KEY':
			case 'ERROR':
				this.options.log(
					'error',
					`the signaling server refused us: ${(message.payload as { msg?: string })?.msg ?? 'no reason given'}`
				);
				this.close('refused');
				return;
			case 'EXPIRE':
				this.options.log('warn', 'the offer expired before it was answered');
				this.options.onPeerLeft?.(message.src ?? '');
				return;
			case 'LEAVE':
				this.options.onPeerLeft?.(message.src ?? '');
				return;
			case 'HEARTBEAT':
				// A reply to ours, or the server checking on us. Either way: say we are here.
				this.sendRaw({ type: 'HEARTBEAT' });
				return;
			case 'OFFER':
			case 'ANSWER':
			case 'CANDIDATE': {
				const from = message.src;
				const payload = message.payload as SignalPayload | undefined;
				if (!from || !payload || typeof payload !== 'object') return;
				if (message.type === 'OFFER') {
					this.remoteId = from;
					this.remoteConnectionId = payload.connectionId ?? null;
				}
				this.options.onSignal(payload, from);
				return;
			}
			default:
				return;
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeat = setInterval(() => this.sendRaw({ type: 'HEARTBEAT' }), HEARTBEAT_MS);
		this.heartbeat.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
	}

	private dropSocket(reason: string): void {
		const socket = this.socket;
		this.socket = null;
		this.registered = false;
		this.stopHeartbeat();
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
		this.options.log('info', `${reason}; trying again in ${(wait / 1000).toFixed(1)}s`);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.connect();
		}, wait);
		this.retryTimer.unref?.();
	}
}
