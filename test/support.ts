/**
 * Test-side pieces: a minimal RiozeOS client, a real relay, and two fake services.
 *
 * The client speaks the same protocol the browser app does, with werift standing in for the
 * browser's WebRTC and a local room relay standing in for signal.rioze.dev. That is the point
 * of the exercise: if the daemon satisfies this, it will satisfy the real client, because both
 * sides only ever meet at `protocol.ts`.
 */
import type { ServerWebSocket } from 'bun';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { fingerprintOfPublicKey } from '../src/identity.ts';
import {
	linkRoom,
	makePeerId,
	pairProof,
	PROTOCOL_VERSION,
	SIGNAL_MAX_FRAME,
	SIGNAL_SUBPROTOCOL,
	signalSocketUrl,
	type AuthHelloReply,
	type AuthOkPayload,
	type RelayMessage,
	type RelayOutgoing,
	type RpcWire
} from '../src/protocol.ts';
import { fromBase64, randomNonce, toBase64 } from '../src/util.ts';

const KEY_PARAMS: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

const CHANNEL_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 20000;
const OFFER_RETRY_MS = 2000;
const OFFER_ATTEMPTS = 8;

/**
 * A relay of the tests' own: the same shape as the one RiozeLink meets, on a loopback port.
 *
 * A room is the set of sockets joined to it, a text frame goes to every other socket in that room
 * and to nobody else, and the door is the subprotocol. That is the whole contract the daemon and
 * the client are written against, so this is the whole contract worth reproducing.
 */
export async function startTestSignal(): Promise<{ url: string; close(): Promise<void> }> {
	const rooms = new Map<string, Set<ServerWebSocket<{ room: string }>>>();
	const server = Bun.serve<{ room: string }>({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request, self) {
			const url = new URL(request.url);
			if (url.pathname !== '/ws') return new Response('Not Found', { status: 404 });
			// The door is checked before anything else, exactly as the relay checks it: a socket that
			// did not ask for the subprotocol is not told the difference between a wrong door and no
			// door at all.
			const offered = (request.headers.get('sec-websocket-protocol') ?? '')
				.split(',')
				.map((value) => value.trim());
			if (!offered.includes(SIGNAL_SUBPROTOCOL))
				return new Response('Not Found', { status: 404 });
			const room = (url.searchParams.get('room') ?? '').trim();
			if (!room || room.length > 64) return new Response('Bad Request', { status: 400 });
			if (
				self.upgrade(request, {
					data: { room },
					headers: { 'Sec-WebSocket-Protocol': SIGNAL_SUBPROTOCOL }
				})
			)
				return undefined as unknown as Response;
			return new Response('Upgrade Required', { status: 426 });
		},
		websocket: {
			open(socket) {
				let members = rooms.get(socket.data.room);
				if (!members) {
					members = new Set();
					rooms.set(socket.data.room, members);
				}
				members.add(socket);
			},
			message(socket, payload) {
				// Text only. A binary frame is dropped outright, and an oversized one closes the socket
				// with 1009, both of which the real relay does too.
				if (typeof payload !== 'string') return;
				if (Buffer.byteLength(payload, 'utf8') > SIGNAL_MAX_FRAME) {
					socket.close(1009, 'message exceeds the 64 KiB relay limit');
					return;
				}
				const members = rooms.get(socket.data.room);
				if (!members) return;
				// Verbatim, to everyone else, and never back to the sender.
				for (const peer of members) if (peer !== socket) peer.send(payload);
			},
			close(socket) {
				const members = rooms.get(socket.data.room);
				if (!members) return;
				members.delete(socket);
				if (members.size === 0) rooms.delete(socket.data.room);
			}
		}
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		close: async () => {
			await server.stop(true);
		}
	};
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

export interface TestEvent {
	subsystem: string;
	action: string;
	payload: unknown;
}

/**
 * Registers, offers, and then ignores everything the host says.
 *
 * This is the state a lost answer leaves behind: the host built a peer and answered, the browser
 * never applied that answer, and the host's peer is now the only thing standing between this
 * browser and its next attempt. A new attempt has to be able to push past it.
 */
export async function offerAndStall(signalUrl: string, room: string): Promise<{ close(): void }> {
	const id = makePeerId('rz-c');
	const socket = new WebSocket(signalSocketUrl(signalUrl, room), [SIGNAL_SUBPROTOCOL]);
	const peer = new RTCPeerConnection({ iceAdditionalHostAddresses: ['127.0.0.1'] });
	peer.createDataChannel('rioze', { ordered: true });
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('the stalled client never joined')), 8000);
		socket.onopen = () => {
			clearTimeout(timer);
			resolve();
		};
		socket.onerror = () => {
			clearTimeout(timer);
			reject(new Error('the stalled client could not join'));
		};
	});
	const description = await peer.createOffer();
	await peer.setLocalDescription({ type: 'offer', sdp: description.sdp });
	socket.send(
		JSON.stringify({
			type: 'offer',
			room,
			from: id,
			ts: Date.now(),
			sdp: description.sdp ?? ''
		})
	);
	return {
		close: () => {
			try {
				void peer.close();
			} catch {
				// Already gone.
			}
			try {
				socket.close();
			} catch {
				// Already gone.
			}
		}
	};
}

export class TestClient {
	static async connect(
		signalUrl: string,
		room: string,
		options: { name?: string; keyPair?: CryptoKeyPair } = {}
	): Promise<TestClient> {
		const client = new TestClient();
		client.name = options.name ?? 'Test Browser';
		client.room = room;
		client.keyPair =
			options.keyPair ?? (await crypto.subtle.generateKey(KEY_PARAMS, true, ['sign', 'verify']));
		const spki = await crypto.subtle.exportKey('spki', client.keyPair.publicKey);
		client.publicKey = toBase64(new Uint8Array(spki));

		client.peer = new RTCPeerConnection({ iceAdditionalHostAddresses: ['127.0.0.1'] });
		client.channel = client.peer.createDataChannel('rioze', { ordered: true });
		client.channel.onMessage.subscribe((data) => {
			client.onText(typeof data === 'string' ? data : data.toString('utf8'));
		});

		const socket = new WebSocket(signalSocketUrl(signalUrl, room), [SIGNAL_SUBPROTOCOL]);
		client.socket = socket;
		socket.onmessage = (event) => void client.onSignalMessage(String(event.data));
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('the relay socket did not open')), 8000);
			socket.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error('the relay refused the socket'));
			};
		});

		client.peer.onIceCandidate.subscribe((candidate) => {
			if (!candidate) return;
			const json = candidate.toJSON();
			client.send({
				type: 'candidate',
				to: client.remoteId,
				candidate: json.candidate,
				sdpMid: json.sdpMid ?? null,
				sdpMLineIndex: json.sdpMLineIndex ?? null
			});
		});

		// The relay holds nothing, so a room nobody is in yet simply swallows what was sent to it.
		// An offer that arrived too early is offered again, which is what the real client does too.
		const offer = async (): Promise<void> => {
			const description = await client.peer.createOffer();
			await client.peer.setLocalDescription({ type: 'offer', sdp: description.sdp });
			client.send({ type: 'offer', sdp: description.sdp ?? '' });
		};
		await offer();
		const answered = withTimeout(
			new Promise<void>((resolve) => {
				client.sawAnswer = resolve;
			}),
			CHANNEL_TIMEOUT_MS,
			'the host to answer an offer'
		);
		for (let attempt = 1; attempt < OFFER_ATTEMPTS; attempt += 1) {
			const retry = await Promise.race([
				answered.then(() => false),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(true), OFFER_RETRY_MS))
			]);
			if (!retry) break;
			await offer();
		}
		await answered;

		await withTimeout(
			new Promise<void>((resolve) => {
				client.channel.stateChange.subscribe((state) => {
					if (state === 'open') resolve();
				});
			}),
			CHANNEL_TIMEOUT_MS,
			'the data channel'
		);
		return client;
	}

	readonly events: TestEvent[] = [];
	helloReply: AuthHelloReply | null = null;
	name = 'Test Browser';
	publicKey = '';
	keyPair!: CryptoKeyPair;
	/** This client's own id inside the room. The relay assigns nothing, so the id is ours to pick. */
	readonly id = makePeerId('rz-c');
	/** The other end's id, learned from the first frame it addresses to us. */
	remoteId: string | undefined;

	private room = '';
	private peer!: RTCPeerConnection;
	private channel!: RTCDataChannel;
	private socket!: WebSocket;
	private sawAnswer: (() => void) | null = null;
	private readonly pending = new Map<string, (message: RpcWire & { kind: 'res' }) => void>();
	private readonly waiters: Array<{
		action: string;
		match: ((event: TestEvent) => boolean) | null;
		resolve: (event: TestEvent) => void;
	}> = [];
	private seq = 0;

	private send(message: RelayOutgoing): void {
		this.socket.send(JSON.stringify({ ...message, room: this.room, from: this.id, ts: Date.now() }));
	}

	private async onSignalMessage(text: string): Promise<void> {
		let message: RelayMessage;
		try {
			message = JSON.parse(text) as RelayMessage;
		} catch {
			return;
		}
		// The relay does not echo, and a room is meant to hold two ends, so anything sent by a
		// bystander or addressed elsewhere is not this handshake's business.
		if (!message.type || !message.from || message.from === this.id) return;
		if (message.to && message.to !== this.id) return;
		if (this.remoteId && message.from !== this.remoteId) return;
		if (message.type === 'answer') {
			this.remoteId = message.from;
			await this.peer.setRemoteDescription({ type: 'answer', sdp: message.sdp ?? '' });
			this.sawAnswer?.();
			return;
		}
		if (message.type === 'candidate') {
			this.remoteId ??= message.from;
			if (!message.candidate) {
				await this.peer.addIceCandidate(null);
				return;
			}
			await this.peer.addIceCandidate({
				candidate: message.candidate,
				sdpMid: message.sdpMid ?? undefined,
				sdpMLineIndex: message.sdpMLineIndex ?? undefined
			});
		}
	}

	private onText(text: string): void {
		const message = JSON.parse(text) as RpcWire;
		if (message.kind === 'res') {
			const resolve = this.pending.get(message.id);
			if (!resolve) throw new Error(`a reply arrived for an unknown id: ${message.id}`);
			this.pending.delete(message.id);
			resolve(message);
			return;
		}
		if (message.kind === 'evt') {
			const event: TestEvent = {
				subsystem: message.subsystem,
				action: message.action,
				payload: message.payload
			};
			this.events.push(event);
			for (const waiter of [...this.waiters]) {
				if (waiter.action !== `${message.subsystem}:${message.action}`) continue;
				if (waiter.match && !waiter.match(event)) continue;
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				waiter.resolve(event);
			}
		}
	}

	async call(subsystem: string, action: string, payload: unknown = {}): Promise<any> {
		this.seq += 1;
		const id = `t${this.seq}`;
		const reply = new Promise<RpcWire & { kind: 'res' }>((resolve) => {
			this.pending.set(id, resolve);
		});
		this.channel.send(JSON.stringify({ kind: 'req', id, subsystem, action, payload }));
		const message = await withTimeout(reply, CALL_TIMEOUT_MS, `${subsystem}:${action}`);
		if (!message.ok) throw new Error(`${message.error.code}: ${message.error.message}`);
		return message.payload;
	}

	/** Calls a request that is expected to fail, and answers with the error code. */
	async expectFailure(
		subsystem: string,
		action: string,
		payload: unknown = {}
	): Promise<{ code: string; message: string }> {
		try {
			await this.call(subsystem, action, payload);
		} catch (error) {
			const [code, ...rest] = (error as Error).message.split(':');
			return { code, message: rest.join(':').trim() };
		}
		throw new Error(`${subsystem}:${action} was expected to fail`);
	}

	waitForEvent(
		subsystem: string,
		action: string,
		match?: (event: TestEvent) => boolean,
		timeoutMs = 10000
	): Promise<TestEvent> {
		const key = `${subsystem}:${action}`;
		return withTimeout(
			new Promise<TestEvent>((resolve) => {
				this.waiters.push({ action: key, match: match ?? null, resolve });
			}),
			timeoutMs,
			`the ${key} event`
		);
	}

	private async sign(data: Uint8Array<ArrayBuffer>): Promise<string> {
		const signature = await crypto.subtle.sign(SIGN_PARAMS, this.keyPair.privateKey, data);
		return toBase64(new Uint8Array(signature));
	}

	async hello(): Promise<AuthHelloReply> {
		const clientNonce = randomNonce();
		const reply = (await this.call('auth', 'hello', {
			clientName: this.name,
			publicKey: this.publicKey,
			clientNonce,
			protocol: PROTOCOL_VERSION
		})) as AuthHelloReply;
		const hostKey = await crypto.subtle.importKey(
			'spki',
			fromBase64(reply.publicKey),
			KEY_PARAMS,
			false,
			['verify']
		);
		const ok = await crypto.subtle.verify(
			SIGN_PARAMS,
			hostKey,
			fromBase64(reply.signature),
			fromBase64(clientNonce)
		);
		if (!ok) throw new Error('the host signature did not verify');
		this.helloReply = reply;
		return reply;
	}

	/** The exact body a pairing request carries. Tests use it to send a wrong proof on purpose. */
	async pairPayload(
		phrase: string
	): Promise<{ proof: string; signature: string; clientName: string }> {
		if (!this.helloReply) await this.hello();
		const hostNonce = this.helloReply!.hostNonce;
		return {
			proof: await pairProof(phrase, hostNonce),
			signature: await this.sign(fromBase64(hostNonce)),
			clientName: this.name
		};
	}

	async pair(phrase: string): Promise<AuthOkPayload> {
		return (await this.call('auth', 'pair', await this.pairPayload(phrase))) as AuthOkPayload;
	}

	async prove(): Promise<AuthOkPayload> {
		if (!this.helloReply) await this.hello();
		const signature = await this.sign(fromBase64(this.helloReply!.hostNonce));
		return (await this.call('auth', 'prove', { signature })) as AuthOkPayload;
	}

	/** The room this client and the host meet in after pairing. No words needed, ever again. */
	async idForReconnect(): Promise<string> {
		if (!this.helloReply) throw new Error('hello first');
		const hostHex = fingerprintOfPublicKey(this.helloReply.publicKey).fingerprintHex;
		const ownHex = fingerprintOfPublicKey(this.publicKey).fingerprintHex;
		return linkRoom(hostHex, ownHex);
	}

	close(): void {
		try {
			this.channel.close();
		} catch {
			// Already gone.
		}
		try {
			void this.peer.close();
		} catch {
			// Already gone.
		}
		this.socket.close();
	}
}

/** A fake AnkiConnect. Two actions, one of which fails on purpose. */
export function mockAnki(): { port: number; stop(): void } {
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const body = (await request.json()) as { action?: string };
			if (body.action === 'version') return Response.json({ result: 6, error: null });
			if (body.action === 'deckNames') return Response.json({ result: ['Default'], error: null });
			return Response.json({ result: null, error: `unsupported action: ${body.action}` });
		}
	});
	return { port: server.port as number, stop: () => void server.stop(true) };
}

/** A fake Ollama. Streams one word per chunk, so the client has something to concatenate. */
export function mockOllama(): { port: number; stop(): void } {
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (url.pathname === '/api/tags') {
				return Response.json({ models: [{ name: 'mock:latest' }] });
			}
			if (url.pathname === '/api/chat') {
				const words = ['Hello', 'from', 'the', 'mock.'];
				const encoder = new TextEncoder();
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						words.forEach((word, index) => {
							const delta = index === words.length - 1 ? word : `${word} `;
							controller.enqueue(
								encoder.encode(
									`${JSON.stringify({ message: { role: 'assistant', content: delta }, done: false })}\n`
								)
							);
						});
						controller.enqueue(encoder.encode(`${JSON.stringify({ done: true })}\n`));
						controller.close();
					}
				});
				return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
			}
			return new Response('not found', { status: 404 });
		}
	});
	return { port: server.port as number, stop: () => void server.stop(true) };
}
