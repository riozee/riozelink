/**
 * Test-side pieces: a minimal RiozeOS client, a real signaling server, and two fake services.
 *
 * The client speaks the same protocol the browser app does, with werift standing in for the
 * browser's WebRTC and the `peer` dev dependency standing in for 0.peerjs.com. That is the point
 * of the exercise: if the daemon satisfies this, it will satisfy the real client, because both
 * sides only ever meet at `protocol.ts`.
 */
import type { Server } from 'node:http';
import { PeerServer } from 'peer';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { fingerprintOfPublicKey } from '../src/identity.ts';
import {
	candidatePayload,
	isOfferPayload,
	linkId,
	makeSignalId,
	offerPayload,
	pairProof,
	PROTOCOL_VERSION,
	signalSocketUrl,
	type AuthHelloReply,
	type AuthOkPayload,
	type RpcWire,
	type SignalMessage,
	type SignalPayload
} from '../src/protocol.ts';
import { fromBase64, randomNonce, toBase64 } from '../src/util.ts';

const KEY_PARAMS: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

const CHANNEL_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 20000;
const OFFER_RETRY_MS = 2000;
const OFFER_ATTEMPTS = 8;

/**
 * A signaling server of the tests' own: the real PeerServer package, on a loopback port nothing
 * else is using. The daemon and the test client both only see a URL.
 */
export async function startTestSignal(): Promise<{ url: string; close(): Promise<void> }> {
	const http = await new Promise<Server>((resolve) => {
		PeerServer({ port: 0, host: '127.0.0.1', path: '/' }, (server) => resolve(server));
	});
	const address = http.address();
	if (!address || typeof address === 'string')
		throw new Error('the test signal server has no port');
	return {
		url: `ws://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve) => http.close(() => resolve()))
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

export class TestClient {
	static async connect(
		signalUrl: string,
		targetId: string,
		options: { name?: string; keyPair?: CryptoKeyPair } = {}
	): Promise<TestClient> {
		const client = new TestClient();
		client.name = options.name ?? 'Test Browser';
		client.targetId = targetId;
		client.keyPair =
			options.keyPair ?? (await crypto.subtle.generateKey(KEY_PARAMS, true, ['sign', 'verify']));
		const spki = await crypto.subtle.exportKey('spki', client.keyPair.publicKey);
		client.publicKey = toBase64(new Uint8Array(spki));

		client.peer = new RTCPeerConnection({ iceAdditionalHostAddresses: ['127.0.0.1'] });
		client.channel = client.peer.createDataChannel('rioze', { ordered: true });
		client.channel.onMessage.subscribe((data) => {
			client.onText(typeof data === 'string' ? data : data.toString('utf8'));
		});

		const socket = new WebSocket(signalSocketUrl(signalUrl, client.signalId, `${Math.random()}`));
		client.socket = socket;
		socket.onmessage = (event) => void client.onSignalMessage(String(event.data));
		const registered = new Promise<void>((resolve, reject) => {
			client.onRegistered = resolve;
			client.onSignalFailure = reject;
			setTimeout(() => reject(new Error('the signaling server never registered us')), 8000);
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('the signaling socket did not open')), 8000);
			socket.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new Error('the signaling socket failed'));
			};
		});
		await registered;

		client.peer.onIceCandidate.subscribe((candidate) => {
			if (!candidate) return;
			client.send({
				type: 'CANDIDATE',
				dst: targetId,
				payload: candidatePayload(candidate.toJSON(), client.connectionId)
			});
		});

		// A server queues frames for an id that is not registered yet and drops the queue after a
		// few seconds, so an offer that arrived too early is simply offered again. The real client
		// retries the same way.
		const offer = async (): Promise<void> => {
			const description = await client.peer.createOffer();
			await client.peer.setLocalDescription({ type: 'offer', sdp: description.sdp });
			client.send({
				type: 'OFFER',
				dst: targetId,
				payload: offerPayload(description.sdp ?? '', client.connectionId)
			});
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
		client.startHeartbeat();
		return client;
	}

	readonly events: TestEvent[] = [];
	helloReply: AuthHelloReply | null = null;
	name = 'Test Browser';
	publicKey = '';
	keyPair!: CryptoKeyPair;
	/** This client's own peer id on the signaling server. */
	readonly signalId = makeSignalId();
	readonly connectionId = `test-${Math.random().toString(16).slice(2, 10)}`;

	private targetId = '';
	private peer!: RTCPeerConnection;
	private channel!: RTCDataChannel;
	private socket!: WebSocket;
	private heartbeat: NodeJS.Timeout | null = null;
	private onRegistered: (() => void) | null = null;
	private onSignalFailure: ((error: Error) => void) | null = null;
	private sawAnswer: (() => void) | null = null;
	private readonly pending = new Map<string, (message: RpcWire & { kind: 'res' }) => void>();
	private readonly waiters: Array<{
		action: string;
		match: ((event: TestEvent) => boolean) | null;
		resolve: (event: TestEvent) => void;
	}> = [];
	private seq = 0;

	private send(message: SignalMessage): void {
		this.socket.send(JSON.stringify(message));
	}

	private startHeartbeat(): void {
		this.heartbeat = setInterval(() => {
			if (this.socket.readyState === WebSocket.OPEN)
				this.socket.send(JSON.stringify({ type: 'HEARTBEAT' }));
		}, 5000);
	}

	private async onSignalMessage(text: string): Promise<void> {
		let message: SignalMessage;
		try {
			message = JSON.parse(text) as SignalMessage;
		} catch {
			return;
		}
		switch (message.type) {
			case 'OPEN':
				this.onRegistered?.();
				return;
			case 'HEARTBEAT':
				this.socket.send(JSON.stringify({ type: 'HEARTBEAT' }));
				return;
			case 'ID-TAKEN':
			case 'INVALID-KEY':
			case 'ERROR':
				this.onSignalFailure?.(new Error(`the signaling server refused us: ${message.type}`));
				return;
			case 'ANSWER':
			case 'CANDIDATE': {
				const payload = message.payload as SignalPayload | undefined;
				if (!payload) return;
				if (isOfferPayload(payload)) {
					await this.peer.setRemoteDescription({ type: 'answer', sdp: payload.sdp.sdp });
					this.sawAnswer?.();
					return;
				}
				if (!payload.candidate) {
					await this.peer.addIceCandidate(null);
					return;
				}
				await this.peer.addIceCandidate({
					candidate: payload.candidate.candidate,
					sdpMid: payload.candidate.sdpMid,
					sdpMLineIndex: payload.candidate.sdpMLineIndex
				});
				return;
			}
			default:
				return;
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

	/** The peer id this client and the host meet at after pairing. No words needed, ever again. */
	async idForReconnect(): Promise<string> {
		if (!this.helloReply) throw new Error('hello first');
		const hostHex = fingerprintOfPublicKey(this.helloReply.publicKey).fingerprintHex;
		const ownHex = fingerprintOfPublicKey(this.publicKey).fingerprintHex;
		return linkId(hostHex, ownHex);
	}

	close(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
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
