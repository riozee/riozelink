/**
 * The relay, deployed once so nobody has to think about infrastructure again.
 *
 * One Durable Object per room, at most two hibernating WebSockets per room, and nothing kept
 * anywhere: a room exists while two ends are in it and is gone the moment they leave. The relay
 * sees a room name (a hash of the four words, or of two fingerprints) and opaque SDP and ICE
 * payloads. It cannot read a file, a phrase, or a message — those travel between the two peers
 * over an encrypted DataChannel that never passes through here.
 *
 * A plain Worker on purpose: `wrangler deploy` from this folder, no accounts, no database.
 */
import type { RelayMessage } from '../../src/protocol.ts';

/** One room holds two sockets: the host and one client. A third is always a stranger. */
const ROOM_CAPACITY = 2;
/** Joins per room per minute, before the relay starts turning people away. */
const JOIN_CAP_PER_MINUTE = 40;

interface Env {
	ROOMS: DurableObjectNamespace;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/health') {
			return Response.json({ service: 'riozelink-relay', ok: true });
		}
		const room = url.searchParams.get('room');
		if (!room) {
			return new Response('a room name is required: /?room=<name>', { status: 400 });
		}
		const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
		return stub.fetch(request);
	}
};

interface Attachment {
	joined: boolean;
}

export class Room implements DurableObject {
	private joins: number[] = [];
	private idleSince: number | null = null;

	constructor(private readonly ctx: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('this endpoint speaks WebSocket', { status: 426 });
		}

		const members = this.ctx.getWebSockets();
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		if (members.length >= ROOM_CAPACITY) {
			this.ctx.acceptWebSocket(server);
			server.send(
				JSON.stringify({
					t: 'error',
					reason: 'this room already has two members',
					fatal: true
				} satisfies RelayMessage)
			);
			server.close(1013, 'room full');
			return new Response(null, { status: 101, webSocket: client });
		}

		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ joined: false } satisfies Attachment);
		this.idleSince = null;
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): void {
		if (typeof raw !== 'string') {
			this.fail(socket, 'the message was not JSON');
			return;
		}
		let message: RelayMessage;
		try {
			message = JSON.parse(raw) as RelayMessage;
		} catch {
			this.fail(socket, 'the message was not JSON');
			return;
		}
		const attachment = socket.deserializeAttachment() as Attachment | null;

		if (!attachment?.joined) {
			if (message?.t !== 'join' || typeof message.room !== 'string' || !message.room) {
				this.fail(socket, 'the first message must be a join');
				return;
			}
			const now = Date.now();
			this.joins = this.joins.filter((at) => now - at < 60_000);
			if (this.joins.length >= JOIN_CAP_PER_MINUTE) {
				this.fail(socket, 'too many joins for this room; wait a minute and try again');
				return;
			}
			this.joins.push(now);
			socket.serializeAttachment({ joined: true } satisfies Attachment);
			socket.send(
				JSON.stringify({
					t: 'joined',
					room: message.room,
					peers: this.ctx.getWebSockets().length - 1
				} satisfies RelayMessage)
			);
			this.broadcast(socket, { t: 'peer', event: 'joined' });
			return;
		}

		if (message?.t === 'signal') {
			this.broadcast(socket, { t: 'signal', data: message.data });
			return;
		}
		if (message?.t === 'ping') {
			socket.send(JSON.stringify({ t: 'pong' } satisfies RelayMessage));
		}
	}

	webSocketClose(socket: WebSocket): void {
		this.broadcast(socket, { t: 'peer', event: 'left' });
	}

	webSocketError(socket: WebSocket): void {
		this.broadcast(socket, { t: 'peer', event: 'left' });
	}

	/** Sends to every member of the room except the one the message came from. */
	private broadcast(from: WebSocket, message: RelayMessage): void {
		const text = JSON.stringify(message);
		for (const member of this.ctx.getWebSockets()) {
			if (member === from) continue;
			try {
				member.send(text);
			} catch {
				// A closed socket is not a reason to take the room down.
			}
		}
	}

	private fail(socket: WebSocket, reason: string): void {
		try {
			socket.send(JSON.stringify({ t: 'error', reason, fatal: true } satisfies RelayMessage));
			socket.close(1008, reason);
		} catch {
			// Already gone.
		}
	}
}
