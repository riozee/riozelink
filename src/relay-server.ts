/**
 * The relay, as a process you can run yourself.
 *
 * This is the same small protocol the Cloudflare Worker in `relay/` serves: rooms of at most two
 * members, `signal` frames forwarded to the other member, presence notices, nothing stored and
 * nothing logged about the room itself. It exists so a person can keep the meeting point on their
 * own machine or their own server, and so the tests can talk to a real relay without the internet.
 *
 * `riozelink relay` runs exactly this.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { RelayMessage } from './protocol.ts';

/** One room holds two sockets: the host and one client. A third is always a stranger. */
const ROOM_CAPACITY = 2;
/** Joins per room per minute, before the relay starts turning people away. */
const JOIN_CAP_PER_MINUTE = 40;
const HEARTBEAT_MS = 30_000;

/** Where `riozelink relay` listens unless the operator picks a port. */
export const DEFAULT_RELAY_PORT = 4400;

export interface RelayServerOptions {
	port: number;
	/** `0.0.0.0` unless the operator asked for something narrower. */
	host?: string;
	log?(level: 'info' | 'warn', message: string): void;
}

export interface RelayServer {
	readonly port: number;
	/** How many rooms are open right now. The tests use it; nothing else has a reason to. */
	roomCount(): number;
	close(): Promise<void>;
}

interface Room {
	members: Set<WebSocket>;
	joins: number[];
}

export function createRelayServer(options: RelayServerOptions): Promise<RelayServer> {
	return new Promise((resolve, reject) => {
		const log = options.log ?? (() => undefined);
		const server = new WebSocketServer({ port: options.port, host: options.host ?? '0.0.0.0' });
		const rooms = new Map<string, Room>();
		const sockets = new Set<WebSocket>();
		let settled = false;

		server.on('error', (error) => {
			if (!settled) {
				settled = true;
				reject(error);
				return;
			}
			log('warn', `relay: ${error.message}`);
		});

		server.on('listening', () => {
			settled = true;
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : options.port;
			resolve({
				port,
				roomCount: () => rooms.size,
				close: () => closeServer(server, sockets, heartbeat)
			});
		});

		server.on('connection', (socket) => {
			sockets.add(socket);
			handleSocket(socket, rooms, log);
			socket.on('close', () => sockets.delete(socket));
		});

		const heartbeat = setInterval(() => {
			for (const socket of sockets) {
				if (socket.readyState === socket.OPEN) socket.ping();
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

function handleSocket(
	socket: WebSocket,
	rooms: Map<string, Room>,
	log: (level: 'info' | 'warn', message: string) => void
): void {
	let joinedRoom: string | null = null;

	const send = (message: RelayMessage): void => {
		if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
	};

	const leave = (): void => {
		if (!joinedRoom) return;
		const key = joinedRoom;
		const room = rooms.get(key);
		joinedRoom = null;
		if (!room) return;
		room.members.delete(socket);
		for (const member of room.members) {
			if (member.readyState === member.OPEN) {
				member.send(JSON.stringify({ t: 'peer', event: 'left' } satisfies RelayMessage));
			}
		}
		if (room.members.size === 0) rooms.delete(key);
	};

	socket.on('message', (raw) => {
		let message: RelayMessage;
		try {
			message = JSON.parse(String(raw)) as RelayMessage;
		} catch {
			send({ t: 'error', reason: 'the message was not JSON', fatal: true });
			socket.close();
			return;
		}

		if (!joinedRoom) {
			if (message?.t !== 'join' || typeof message.room !== 'string' || !message.room) {
				send({ t: 'error', reason: 'the first message must be a join', fatal: true });
				socket.close();
				return;
			}
			const now = Date.now();
			let room = rooms.get(message.room);
			if (!room) {
				room = { members: new Set(), joins: [] };
				rooms.set(message.room, room);
			}
			room.joins = room.joins.filter((at) => now - at < 60_000);
			if (room.joins.length >= JOIN_CAP_PER_MINUTE) {
				log('warn', `relay: a room is being hammered (${room.joins.length} joins this minute)`);
				send({
					t: 'error',
					reason: 'too many joins for this room; wait a minute and try again',
					fatal: true
				});
				socket.close();
				if (room.members.size === 0) rooms.delete(message.room);
				return;
			}
			if (room.members.size >= ROOM_CAPACITY) {
				send({ t: 'error', reason: 'this room already has two members', fatal: true });
				socket.close();
				return;
			}
			room.joins.push(now);
			room.members.add(socket);
			joinedRoom = message.room;
			send({ t: 'joined', room: message.room, peers: room.members.size - 1 });
			for (const member of room.members) {
				if (member !== socket && member.readyState === member.OPEN) {
					member.send(JSON.stringify({ t: 'peer', event: 'joined' } satisfies RelayMessage));
				}
			}
			return;
		}

		if (message?.t === 'signal') {
			const room = rooms.get(joinedRoom);
			if (!room) return;
			const text = JSON.stringify({ t: 'signal', data: message.data });
			for (const member of room.members) {
				if (member !== socket && member.readyState === member.OPEN) member.send(text);
			}
			return;
		}
		if (message?.t === 'ping') {
			send({ t: 'pong' });
			return;
		}
	});

	socket.on('close', leave);
	socket.on('error', () => undefined);
}
