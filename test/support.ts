/**
 * Test-side pieces: a minimal RiozeOS client and two fake services.
 *
 * The client speaks the same protocol the browser app does, with werift standing in for the
 * browser's WebRTC. That is the point of the exercise: if the daemon satisfies this, it will
 * satisfy the real client, because both sides only ever meet at `protocol.ts`.
 */
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import {
	PROTOCOL_VERSION,
	hostRoom,
	pairRoom,
	type AuthHelloReply,
	type AuthOkPayload,
	type RpcWire,
	type SignalMessage
} from '../src/protocol.ts';
import { fromBase64, randomNonce, toBase64 } from '../src/util.ts';

const KEY_PARAMS: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

const CHANNEL_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 20000;

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
		address: string,
		room: string,
		options: { name?: string; keyPair?: CryptoKeyPair } = {}
	): Promise<TestClient> {
		const client = new TestClient();
		client.name = options.name ?? 'Test Browser';
		client.keyPair =
			options.keyPair ?? (await crypto.subtle.generateKey(KEY_PARAMS, true, ['sign', 'verify']));
		const spki = await crypto.subtle.exportKey('spki', client.keyPair.publicKey);
		client.publicKey = toBase64(new Uint8Array(spki));

		client.peer = new RTCPeerConnection({ iceAdditionalHostAddresses: ['127.0.0.1'] });
		client.channel = client.peer.createDataChannel('rioze', { ordered: true });
		client.channel.onMessage.subscribe((data) => {
			client.onText(typeof data === 'string' ? data : data.toString('utf8'));
		});

		const socket = new WebSocket(address);
		client.socket = socket;
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

		const joined = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('the room never answered')), 8000);
			client.onSignal = (message) => {
				if (message.t === 'joined') {
					clearTimeout(timer);
					resolve();
				}
				if (message.t === 'error') {
					clearTimeout(timer);
					reject(new Error(message.reason));
				}
			};
			socket.onmessage = (event) => {
				const message = JSON.parse(String(event.data)) as SignalMessage;
				if (message.t === 'signal') void client.onRemoteSignal(message.data);
				else client.onSignal?.(message);
			};
		});
		socket.send(JSON.stringify({ t: 'join', room, role: 'client', name: client.name }));
		await joined;

		client.peer.onIceCandidate.subscribe((candidate) => {
			client.send({
				t: 'signal',
				data: { type: 'candidate', candidate: candidate ? candidate.toJSON() : null }
			});
		});
		const offer = await client.peer.createOffer();
		await client.peer.setLocalDescription({ type: 'offer', sdp: offer.sdp });
		client.send({ t: 'signal', data: { type: 'offer', sdp: offer.sdp } });

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

	private peer!: RTCPeerConnection;
	private channel!: RTCDataChannel;
	private socket!: WebSocket;
	private onSignal: ((message: SignalMessage) => void) | null = null;
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

	private async onRemoteSignal(data: Extract<SignalMessage, { t: 'signal' }>['data']): Promise<void> {
		if (data.type === 'answer') {
			await this.peer.setRemoteDescription({ type: 'answer', sdp: data.sdp });
			return;
		}
		if (data.type === 'candidate') {
			if (!data.candidate) {
				await this.peer.addIceCandidate(null);
				return;
			}
			await this.peer.addIceCandidate({
				candidate: data.candidate.candidate,
				sdpMid: data.candidate.sdpMid,
				sdpMLineIndex: data.candidate.sdpMLineIndex
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

	async pair(code: string): Promise<AuthOkPayload> {
		if (!this.helloReply) await this.hello();
		const signature = await this.sign(fromBase64(this.helloReply!.hostNonce));
		return (await this.call('auth', 'pair', {
			code,
			signature,
			clientName: this.name
		})) as AuthOkPayload;
	}

	async prove(): Promise<AuthOkPayload> {
		if (!this.helloReply) await this.hello();
		const signature = await this.sign(fromBase64(this.helloReply!.hostNonce));
		return (await this.call('auth', 'prove', { signature })) as AuthOkPayload;
	}

	roomForReconnect(): string {
		if (!this.helloReply) throw new Error('hello first');
		return hostRoom(this.helloReply.fingerprint.replaceAll(' ', ''));
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

export { pairRoom };

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
