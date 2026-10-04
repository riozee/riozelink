/**
 * The AI gateway's address rules.
 *
 * These pin the 404 that started this file. An endpoint that already carried its API path
 * (`https://api.deepseek.com/v1`, a full `/v1/chat/completions` URL, or Ollama's OpenAI-compatible
 * `/v1` address while the Ollama provider is selected) used to have a second path appended, and
 * every request came back 404 whatever the model was called.
 */
import { expect, test } from 'bun:test';
import { AiService, resolveAiUrls } from '../src/ai.ts';
import type { AiHost, AiStreamSink } from '../src/ai.ts';
import { defaultConfig } from '../src/config.ts';
import type { AiMessage, AiProvider } from '../src/protocol.ts';
import { mockOllama } from './support.ts';

test('every pasted endpoint shape resolves to one API path', () => {
	const deepseek = 'https://api.deepseek.com';
	const expected = {
		chat: 'https://api.deepseek.com/v1/chat/completions',
		models: 'https://api.deepseek.com/v1/models'
	};
	expect(resolveAiUrls(deepseek, 'openai')).toEqual(expected);
	expect(resolveAiUrls(`${deepseek}/`, 'openai')).toEqual(expected);
	expect(resolveAiUrls(`${deepseek}/v1`, 'openai')).toEqual(expected);
	expect(resolveAiUrls(`${deepseek}/v1/`, 'openai')).toEqual(expected);
	expect(resolveAiUrls(`${deepseek}/v1/chat/completions`, 'openai')).toEqual(expected);
	expect(resolveAiUrls(`${deepseek}/v1/models`, 'openai')).toEqual(expected);

	const native = {
		chat: 'http://127.0.0.1:11434/api/chat',
		models: 'http://127.0.0.1:11434/api/tags'
	};
	expect(resolveAiUrls('http://127.0.0.1:11434', 'ollama')).toEqual(native);
	expect(resolveAiUrls('http://127.0.0.1:11434/v1', 'ollama')).toEqual(native);
	expect(resolveAiUrls('http://127.0.0.1:11434/api', 'ollama')).toEqual(native);
	expect(resolveAiUrls('http://127.0.0.1:11434/api/chat', 'ollama')).toEqual(native);
});

/** A strict OpenAI-compatible server, living under `/v1` the way the real ones are documented. */
function mockOpenai(): { url: string; paths: string[]; bodies: unknown[]; stop(): void } {
	const paths: string[] = [];
	const bodies: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			paths.push(url.pathname);
			if (url.pathname === '/v1/models') {
				return Response.json({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
			}
			if (url.pathname === '/v1/chat/completions') {
				const parsed = await request.json().catch(() => null);
				if (parsed) bodies.push(parsed);
				const encoder = new TextEncoder();
				const frames = [
					'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
					'data: {"choices":[{"delta":{"content":" from the mock."}}]}\n\n',
					'data: [DONE]\n\n'
				];
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						for (const frame of frames) controller.enqueue(encoder.encode(frame));
						controller.close();
					}
				});
				return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
			}
			return new Response('not found', { status: 404 });
		}
	});
	return { url: `http://127.0.0.1:${server.port}`, paths, bodies, stop: () => void server.stop(true) };
}

function makeService(options: { provider: AiProvider; endpoint: string; model?: string }): {
	service: AiService;
	host: AiHost;
} {
	const config = defaultConfig();
	config.ai.enabled = true;
	config.ai.provider = options.provider;
	config.ai.endpoint = options.endpoint;
	config.ai.model = options.model ?? (options.provider === 'ollama' ? 'mock:latest' : 'mock-model');
	config.ai.apiKey = options.provider === 'openai' ? 'sk-test' : '';
	const host: AiHost = { config, save: async () => undefined };
	return { service: new AiService(host), host };
}

async function runs(
	service: AiService,
	messages: AiMessage[] = [{ role: 'user', content: 'hi' }]
): Promise<{ text: string | null; error: string | null }> {
	const chunks: string[] = [];
	const end = { text: null as string | null };
	const failure = { message: null as string | null };
	const sink: AiStreamSink = {
		chunk: (_id, delta) => chunks.push(delta),
		end: (_id, text) => (end.text = text),
		error: (_id, error) => (failure.message = error.message)
	};
	await service.chat({ streamId: 'test-stream', messages }, sink);
	expect(chunks.join('')).toBe(end.text ?? '');
	return { text: end.text, error: failure.message };
}

test('an OpenAI-compatible base that already carries /v1 is not doubled', async () => {
	const server = mockOpenai();
	try {
		const { service } = makeService({ provider: 'openai', endpoint: `${server.url}/v1` });
		const { text, error } = await runs(service);
		expect(error).toBe(null);
		expect(text).toBe('Hello from the mock.');
		expect(server.paths).toEqual(['/v1/chat/completions']);
	} finally {
		server.stop();
	}
});

test('a bare OpenAI-compatible host still gets /v1', async () => {
	const server = mockOpenai();
	try {
		const { service } = makeService({ provider: 'openai', endpoint: server.url });
		const { text, error } = await runs(service);
		expect(error).toBe(null);
		expect(text).toBe('Hello from the mock.');
		expect(server.paths).toEqual(['/v1/chat/completions']);
	} finally {
		server.stop();
	}
});

test('a full chat URL is accepted as the endpoint', async () => {
	const server = mockOpenai();
	try {
		const { service } = makeService({
			provider: 'openai',
			endpoint: `${server.url}/v1/chat/completions`
		});
		const { text, error } = await runs(service);
		expect(error).toBe(null);
		expect(text).toBe('Hello from the mock.');
		expect(server.paths).toEqual(['/v1/chat/completions']);
	} finally {
		server.stop();
	}
});

/* ------------------------------------------------------------------- images */

/** Stands in for a page render; only its shape matters here. */
const IMAGE = 'data:image/jpeg;base64,RkFLRQ==';

test('an image part reaches an OpenAI-compatible endpoint as an image_url', async () => {
	const server = mockOpenai();
	try {
		const { service, host } = makeService({ provider: 'openai', endpoint: server.url });
		host.config.ai.images = true;
		const { error } = await runs(service, [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'look at this' },
					{ type: 'image', dataUrl: IMAGE }
				]
			}
		]);
		expect(error).toBe(null);
		const body = server.bodies[0] as { messages: Array<{ content: unknown }> };
		expect(body.messages[0].content).toEqual([
			{ type: 'text', text: 'look at this' },
			{ type: 'image_url', image_url: { url: IMAGE } }
		]);
	} finally {
		server.stop();
	}
});

test('an image part reaches Ollama as a bare base64 entry beside the text', async () => {
	const server = mockOllama();
	try {
		const { service, host } = makeService({
			provider: 'ollama',
			endpoint: `http://127.0.0.1:${server.port}`
		});
		host.config.ai.images = true;
		const { error } = await runs(service, [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'one' },
					{ type: 'text', text: 'two' },
					{ type: 'image', dataUrl: IMAGE }
				]
			}
		]);
		expect(error).toBe(null);
		const body = server.bodies[0] as {
			messages: Array<{ role: string; content: string; images?: string[] }>;
		};
		expect(body.messages[0]).toEqual({ role: 'user', content: 'one\ntwo', images: ['RkFLRQ=='] });
	} finally {
		server.stop();
	}
});

test('an image is refused when the settings say the model does not take them', async () => {
	const server = mockOpenai();
	try {
		const { service } = makeService({ provider: 'openai', endpoint: server.url });
		const { error } = await runs(service, [
			{ role: 'user', content: [{ type: 'image', dataUrl: IMAGE }] }
		]);
		expect(error).toContain('does not take images');
		expect(server.bodies.length).toBe(0);
	} finally {
		server.stop();
	}
});

test('a malformed or oversized part fails before anything is sent', async () => {
	const server = mockOpenai();
	try {
		const { service, host } = makeService({ provider: 'openai', endpoint: server.url });
		host.config.ai.images = true;
		const unknown = await runs(service, [
			{ role: 'user', content: [{ type: 'audio', url: 'x' } as never] }
		]);
		expect(unknown.error).toContain('unknown type');
		const oversized = await runs(service, [
			{
				role: 'user',
				content: [{ type: 'image', dataUrl: `data:image/jpeg;base64,${'A'.repeat(200_001)}` }]
			}
		]);
		expect(oversized.error).toContain('over the');
		expect(server.bodies.length).toBe(0);
	} finally {
		server.stop();
	}
});

test('the images switch round-trips through config and status', async () => {
	const server = mockOpenai();
	try {
		const { service } = makeService({ provider: 'openai', endpoint: server.url });
		expect((await service.status()).images).toBe(false);
		const turnedOn = await service.setConfig({ images: true });
		expect(turnedOn.images).toBe(true);
		await service.setConfig({ images: false });
		expect((await service.status()).images).toBe(false);
	} finally {
		server.stop();
	}
});

test('status probes the models URL under the same rules', async () => {
	const server = mockOpenai();
	try {
		const { service } = makeService({ provider: 'openai', endpoint: `${server.url}/v1` });
		const status = await service.status();
		expect(status.available).toBe(true);
		expect(status.models).toEqual(['mock-model']);
		expect(server.paths).toEqual(['/v1/models']);
	} finally {
		server.stop();
	}
});

test("Ollama's OpenAI-compatible address still reaches the native API", async () => {
	const server = mockOllama();
	try {
		const { service } = makeService({
			provider: 'ollama',
			endpoint: `http://127.0.0.1:${server.port}/v1`
		});
		const { text, error } = await runs(service);
		expect(error).toBe(null);
		expect(text).toBe('Hello from the mock.');
		const status = await service.status();
		expect(status.available).toBe(true);
		expect(status.models).toContain('mock:latest');
	} finally {
		server.stop();
	}
});

test('a provider switch brings the new address unless the caller picks one', async () => {
	const { service, host } = makeService({ provider: 'ollama', endpoint: 'http://127.0.0.1:11434' });
	const probed: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		probed.push(String(input));
		return new Response('{}', { status: 404 });
	}) as typeof fetch;
	try {
		await service.setConfig({ provider: 'openai' });
		expect(host.config.ai.endpoint).toBe('https://api.openai.com');
		expect(host.config.ai.model).toBe('gpt-4o-mini');

		await service.setConfig({
			provider: 'openai',
			endpoint: 'https://api.deepseek.com/v1',
			model: 'deepseek-flash'
		});
		expect(host.config.ai.endpoint).toBe('https://api.deepseek.com/v1');
		expect(host.config.ai.model).toBe('deepseek-flash');
		expect(probed).toContain('https://api.deepseek.com/v1/models');
	} finally {
		globalThis.fetch = realFetch;
	}
});
