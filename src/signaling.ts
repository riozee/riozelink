/**
 * The introduction service.
 *
 * Before two peers can talk over WebRTC they have to find each other and swap an offer and an
 * answer. That is all this WebSocket server does. It checks the room name against the open pairing
 * code or against the host's own fingerprint, relays signaling frames for the rest of the
 * connection's life, and never sees a single byte of the actual conversation: the DataChannel is
 * encrypted by DTLS between the two peers, and every session still has to pass the auth exchange
 * on top of it.
 */
import { randomId } from './util.ts';
import type { SignalMessage } from './protocol.ts';
import { WebSocketServer, type WebSocket } from 'ws';

export interface SignalingHostInfo {
	name: string;
	version: string;
	fingerprint: string;
}

export interface SignalingConnection {
	readonly id: string;
	readonly room: string;
	/** How the room was opened. Only used for log lines. */
	readonly kind: 'pair' | 'host';
	readonly clientName: string;
	send(message: SignalMessage): void;
	/** Frames after the join, one handler per connection. */
	onMessage(handler: (message: SignalMessage) => void): void;
	onClose(handler: () => void): void;
	close(reason: string): void;
}

export interface SignalingServerOptions {
	port: number;
	/** `0.0.0.0` unless the user asked for something narrower. */
	host: string;
	info: SignalingHostInfo;
	/** `null` closes the door: the room name is wrong, or its code has expired. */
	resolveRoom(room: string): 'pair' | 'host' | null;
	onConnection(connection: SignalingConnection): void;
	log(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface SignalingServer {
	/** The actual port, which is the requested one unless `0` asked for any free port. */
	readonly port: number;
	close(): Promise<void>;
}

const JOIN_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30000;

export function createSignalingServer(options: SignalingServerOptions): Promise<SignalingServer> {
	return new Promise((resolve, reject) => {
		const server = new WebSocketServer({ port: options.port, host: options.host });
		let settled = false;
		const sockets = new Set<WebSocket>();

		server.on('error', (error) => {
			if (!settled) {
				settled = true;
				reject(error);
				return;
			}
			options.log('error', `signaling: ${error.message}`);
		});

		server.on('listening', () => {
			settled = true;
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : options.port;
			options.log('info', `listening on ${options.host}:${port}`);
			resolve({ port, close: () => closeServer(server, sockets, heartbeat) });
		});

		server.on('connection', (socket) => {
			sockets.add(socket);
			socket.on('close', () => sockets.delete(socket));
			handleSocket(socket, options);
		});

		const heartbeat = setInterval(() => {
			for (const socket of sockets) {
				if (socket.readyState !== socket.OPEN) continue;
				socket.ping();
			}
		}, HEARTBEAT_MS);
		heartbeat.unref?.();
	});
}

function closeServer(
	server: WebSocketServer,
	sockets: Set<WebSocket>,
	heartbeat: NodeJS.Timeout
): Promise<void> {
	clearInterval(heartbeat);
	for (const socket of sockets) socket.terminate();
	return new Promise((resolve) => server.close(() => resolve()));
}

function handleSocket(socket: WebSocket, options: SignalingServerOptions): void {
	const id = randomId();
	let joined = false;
	let handlers: ((message: SignalMessage) => void) | null = null;
	let closed: (() => void) | null = null;

	const send = (message: SignalMessage): void => {
		if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
	};

	const joinDeadline = setTimeout(() => {
		if (joined) return;
		send({ t: 'error', reason: 'no join arrived' });
		socket.close();
	}, JOIN_TIMEOUT_MS);

	socket.on('message', (raw) => {
		let message: SignalMessage;
		try {
			message = JSON.parse(String(raw)) as SignalMessage;
		} catch {
			send({ t: 'error', reason: 'the message was not JSON' });
			socket.close();
			return;
		}

		if (!joined) {
			if (!message || message.t !== 'join' || typeof message.room !== 'string') {
				send({ t: 'error', reason: 'the first message must be a join' });
				socket.close();
				return;
			}
			const kind = options.resolveRoom(message.room);
			if (!kind) {
				options.log('warn', `turned away a join for ${message.room.slice(0, 40)}`);
				send({
					t: 'error',
					reason: 'that room is not open. Check the pairing code and the host address.'
				});
				socket.close();
				return;
			}
			joined = true;
			clearTimeout(joinDeadline);
			const connection: SignalingConnection = {
				id,
				room: message.room,
				kind,
				clientName: typeof message.name === 'string' ? message.name : 'Browser',
				send,
				onMessage: (handler) => {
					handlers = handler;
				},
				onClose: (handler) => {
					closed = handler;
				},
				close: (reason) => {
					send({ t: 'error', reason });
					socket.close();
				}
			};
			send({ t: 'joined', room: message.room, host: options.info });
			options.onConnection(connection);
			return;
		}

		if (message.t === 'ping') {
			send({ t: 'pong' });
			return;
		}
		handlers?.(message);
	});

	socket.on('close', () => {
		clearTimeout(joinDeadline);
		closed?.();
	});

	socket.on('error', () => {
		// A transport error always ends in a close event, which is where cleanup happens.
	});
}
