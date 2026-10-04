/**
 * The AI gateway.
 *
 * Two providers behind one streaming call. Ollama speaks its own NDJSON dialect and needs no key;
 * an OpenAI-compatible endpoint speaks SSE and uses one. The daemon holds the key so the browser
 * never has to, and the client only ever sees the masked form.
 *
 * A stream is identified by a client-chosen `streamId`, which is what makes cancel possible and
 * what keeps two chats in two windows from mixing their chunks.
 */
import type { HostConfig } from './config.ts';
import { DEFAULT_ENDPOINTS, DEFAULT_MODELS } from './config.ts';
import { HostError, requireString } from './errors.ts';
import { AI_IMAGE_MAX_CHARS } from './protocol.ts';
import type {
	AiChatRequest,
	AiContentPart,
	AiMessage,
	AiProvider,
	AiStatusReply,
	RpcErrorInfo
} from './protocol.ts';
import { maskKey, truncate } from './util.ts';

export interface AiHost {
	config: HostConfig;
	save(): Promise<void>;
	/** Optional; the daemon uses it to put stream edges on the terminal panel. */
	log?(message: string): void;
}

export interface AiStreamSink {
	chunk(streamId: string, delta: string): void;
	end(streamId: string, text: string): void;
	error(streamId: string, error: RpcErrorInfo): void;
}

const PROBE_TIMEOUT_MS = 2500;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** True when a message carries at least one image part. */
function hasImagePart(message: AiMessage): boolean {
	return Array.isArray(message.content) && message.content.some((part) => part.type === 'image');
}

/**
 * Where a request actually goes.
 *
 * The endpoint is stored as the user typed it, and people paste what their provider's docs gave
 * them: a bare host, a base that already carries its version segment (`https://api.deepseek.com/v1`
 * is DeepSeek's own wording), a full `/v1/chat/completions` URL, or Ollama's OpenAI-compatible
 * `/v1` address while the Ollama provider is selected. Appending a path to any of those blindly
 * doubled it (`/v1/v1/chat/completions`), and every request came back 404 whatever the model was
 * called. The path is only added where it is missing.
 */
export function resolveAiUrls(
	endpoint: string,
	provider: AiProvider
): { chat: string; models: string } {
	const base = endpoint.trim().replace(/\/+$/, '');
	if (provider === 'ollama') {
		// The native API lives under `/api`. A pasted `/api`, `/api/chat`, `/api/tags` or `/v1`
		// (Ollama's own OpenAI-compatible address) still names the same server, so find its root
		// first and ask the native API.
		const root = base.replace(/\/(?:v\d+|api(?:\/(?:chat|tags))?)$/i, '');
		return { chat: `${root}/api/chat`, models: `${root}/api/tags` };
	}
	// OpenAI-compatible servers answer under `/v1` from a bare host, or under a base that already
	// ends in a version segment (DeepSeek, LM Studio, OpenRouter). A second `/v1` is never right.
	const root = base.replace(/\/(?:chat\/completions|models)$/i, '').replace(/\/+$/, '');
	if (/\/v\d+$/i.test(root)) return { chat: `${root}/chat/completions`, models: `${root}/models` };
	return { chat: `${root}/v1/chat/completions`, models: `${root}/v1/models` };
}

export class AiService {
	private readonly controllers = new Map<string, AbortController>();

	constructor(private readonly host: AiHost) {}

	async status(): Promise<AiStatusReply> {
		const { enabled, provider, endpoint, model, apiKey, images } = this.host.config.ai;
		const probe = await this.probe(provider, endpoint, apiKey);
		return {
			enabled,
			provider,
			endpoint,
			model,
			images,
			keySet: apiKey.length > 0,
			keyMasked: apiKey ? maskKey(apiKey) : null,
			available: probe.ok,
			models: probe.models
		};
	}

	async setConfig(patch: {
		enabled?: unknown;
		provider?: unknown;
		endpoint?: unknown;
		model?: unknown;
		images?: unknown;
	}): Promise<AiStatusReply> {
		const ai = this.host.config.ai;
		if (typeof patch.enabled === 'boolean') ai.enabled = patch.enabled;
		if (typeof patch.images === 'boolean') ai.images = patch.images;
		if (patch.provider === 'ollama' || patch.provider === 'openai') {
			if (patch.provider !== ai.provider) {
				ai.provider = patch.provider;
				// A provider switch brings its own home address and a sensible default model,
				// unless the caller is setting them in the same call.
				ai.endpoint = DEFAULT_ENDPOINTS[patch.provider];
				ai.model = DEFAULT_MODELS[patch.provider];
			}
		}
		if (typeof patch.endpoint === 'string') {
			const endpoint = patch.endpoint.trim().replace(/\/+$/, '');
			if (!/^https?:\/\/[^\s]+$/.test(endpoint)) {
				throw new HostError('the endpoint must be an http(s) URL', 'invalid');
			}
			ai.endpoint = endpoint;
		}
		if (typeof patch.model === 'string') {
			const model = patch.model.trim();
			if (!model) throw new HostError('the model name cannot be empty', 'invalid');
			ai.model = model;
		}
		await this.host.save();
		return this.status();
	}

	async setKey(key: string): Promise<AiStatusReply> {
		const trimmed = key.trim();
		if (!trimmed) throw new HostError('the key cannot be empty', 'invalid');
		this.host.config.ai.apiKey = trimmed;
		await this.host.save();
		return this.status();
	}

	async clearKey(): Promise<AiStatusReply> {
		this.host.config.ai.apiKey = '';
		await this.host.save();
		return this.status();
	}

	cancel(streamId: string): void {
		this.controllers.get(streamId)?.abort();
		this.controllers.delete(streamId);
	}

	cancelAll(): void {
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
	}

	async chat(payload: AiChatRequest, sink: AiStreamSink): Promise<void> {
		const streamId = requireString(payload.streamId, 'streamId');
		const ai = this.host.config.ai;
		if (!ai.enabled) {
			throw new HostError('the AI gateway is turned off in riozelink', 'denied');
		}
		const controller = new AbortController();
		this.controllers.set(streamId, controller);
		try {
			// Validation lives inside the try so a bad payload answers on the stream, where the
			// client already listens, instead of rejecting a call nobody awaits.
			const messages = this.readMessages(payload.messages);
			if (!ai.images && messages.some(hasImagePart)) {
				throw new HostError('the AI settings say this model does not take images', 'denied');
			}
			this.host.log?.(
				`ai chat ${streamId} -> ${ai.provider} ${ai.endpoint} (${payload.model ?? ai.model}, ${messages.length} messages)`
			);
			if (ai.provider === 'ollama') {
				await this.chatOllama(streamId, payload, messages, controller.signal, sink);
			} else {
				await this.chatOpenai(streamId, payload, messages, controller.signal, sink);
			}
		} catch (error) {
			if (!controller.signal.aborted) sink.error(streamId, this.toInfo(error));
		} finally {
			this.controllers.delete(streamId);
		}
	}

	private readMessages(value: unknown): AiMessage[] {
		if (!Array.isArray(value) || value.length === 0) {
			throw new HostError('a chat needs at least one message', 'invalid');
		}
		return value.map((entry, index) => {
			if (!isRecord(entry)) throw new HostError(`message ${index} has no content`, 'invalid');
			const role = entry.role === 'system' || entry.role === 'assistant' ? entry.role : 'user';
			if (typeof entry.content === 'string') return { role, content: entry.content };
			if (!Array.isArray(entry.content) || entry.content.length === 0) {
				throw new HostError(`message ${index} has no content`, 'invalid');
			}
			const content = entry.content.map((part, at) =>
				this.readPart(part, `message ${index} part ${at}`)
			);
			return { role, content };
		});
	}

	/** One content part, validated and normalized. */
	private readPart(value: unknown, where: string): AiContentPart {
		if (!isRecord(value)) throw new HostError(`${where} is not an object`, 'invalid');
		if (value.type === 'text' && typeof value.text === 'string') {
			return { type: 'text', text: value.text };
		}
		if (value.type === 'image' && typeof value.dataUrl === 'string') {
			if (!value.dataUrl.startsWith('data:image/')) {
				throw new HostError(`${where} is not an image data URL`, 'invalid');
			}
			if (value.dataUrl.length > AI_IMAGE_MAX_CHARS) {
				throw new HostError(
					`${where} is ${value.dataUrl.length} characters, over the ${AI_IMAGE_MAX_CHARS} an image may take`,
					'invalid'
				);
			}
			return { type: 'image', dataUrl: value.dataUrl };
		}
		throw new HostError(`${where} has an unknown type`, 'invalid');
	}

	/** The messages in OpenAI's dialect: content arrays carry `image_url` parts. */
	private toOpenaiMessages(messages: AiMessage[]): unknown[] {
		return messages.map((message) => ({
			role: message.role,
			content:
				typeof message.content === 'string'
					? message.content
					: message.content.map((part) =>
							part.type === 'text'
								? { type: 'text', text: part.text }
								: { type: 'image_url', image_url: { url: part.dataUrl } }
						)
		}));
	}

	/** The messages in Ollama's native dialect: text plus a bare base64 `images` array. */
	private toOllamaMessages(messages: AiMessage[]): unknown[] {
		return messages.map((message) => {
			if (typeof message.content === 'string') {
				return { role: message.role, content: message.content };
			}
			const text = message.content
				.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
				.map((part) => part.text)
				.join('\n');
			const images = message.content
				.filter((part): part is { type: 'image'; dataUrl: string } => part.type === 'image')
				.map((part) => part.dataUrl.slice(part.dataUrl.indexOf(',') + 1));
			return { role: message.role, content: text, ...(images.length ? { images } : {}) };
		});
	}

	private async chatOllama(
		streamId: string,
		payload: AiChatRequest,
		messages: AiMessage[],
		signal: AbortSignal,
		sink: AiStreamSink
	): Promise<void> {
		const ai = this.host.config.ai;
		const { chat } = resolveAiUrls(ai.endpoint, 'ollama');
		const response = await this.fetchJson(
			chat,
			{
				model: payload.model ?? ai.model,
				messages: this.toOllamaMessages(messages),
				stream: true,
				...(typeof payload.temperature === 'number'
					? { options: { temperature: payload.temperature } }
					: {})
			},
			undefined,
			signal
		);
		let text = '';
		await this.readLines(response, signal, (line) => {
			const parsed = this.parseJsonLine(line);
			if (!parsed) return;
			if (typeof parsed.error === 'string') throw new HostError(`Ollama: ${parsed.error}`, 'io');
			const message = isRecord(parsed.message) ? parsed.message : null;
			const delta = message && typeof message.content === 'string' ? message.content : '';
			if (delta) {
				text += delta;
				sink.chunk(streamId, delta);
			}
		});
		sink.end(streamId, text);
	}

	private async chatOpenai(
		streamId: string,
		payload: AiChatRequest,
		messages: AiMessage[],
		signal: AbortSignal,
		sink: AiStreamSink
	): Promise<void> {
		const ai = this.host.config.ai;
		const { chat } = resolveAiUrls(ai.endpoint, 'openai');
		const response = await this.fetchJson(
			chat,
			{
				model: payload.model ?? ai.model,
				messages: this.toOpenaiMessages(messages),
				stream: true,
				...(typeof payload.temperature === 'number' ? { temperature: payload.temperature } : {})
			},
			ai.apiKey || undefined,
			signal
		);
		let text = '';
		await this.readLines(response, signal, (line) => {
			if (!line.startsWith('data:')) return;
			const data = line.slice(5).trim();
			if (!data || data === '[DONE]') return;
			const parsed = this.parseJsonLine(data);
			if (!parsed) return;
			if (isRecord(parsed.error)) {
				const message =
					typeof parsed.error.message === 'string' ? parsed.error.message : 'request failed';
				throw new HostError(`the endpoint said: ${truncate(message, 300)}`, 'io');
			}
			const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
			const first = choices[0];
			const delta =
				isRecord(first) && isRecord(first.delta) && typeof first.delta.content === 'string'
					? first.delta.content
					: '';
			if (delta) {
				text += delta;
				sink.chunk(streamId, delta);
			}
		});
		sink.end(streamId, text);
	}

	private async fetchJson(
		url: string,
		body: unknown,
		apiKey: string | undefined,
		signal: AbortSignal
	): Promise<Response> {
		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
				},
				body: JSON.stringify(body),
				signal
			});
		} catch (error) {
			const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause;
			if (cause?.code === 'ECONNREFUSED') {
				throw new HostError(`nothing is listening at ${url}`, 'offline');
			}
			throw new HostError(`could not reach ${url}: ${(error as Error).message}`, 'offline');
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new HostError(
				`the model endpoint answered ${response.status}${detail ? `: ${truncate(detail, 300)}` : ''}`,
				response.status === 401 || response.status === 403 ? 'denied' : 'io'
			);
		}
		if (!response.body) throw new HostError('the endpoint sent no stream', 'io');
		return response;
	}

	/** Reads a text stream line by line; each complete line goes to `onLine`. */
	private async readLines(
		response: Response,
		signal: AbortSignal,
		onLine: (line: string) => void
	): Promise<void> {
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			if (signal.aborted) throw new HostError('cancelled', 'unknown');
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf('\n');
			while (index >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line) onLine(line);
				index = buffer.indexOf('\n');
			}
		}
		const tail = buffer.trim();
		if (tail) onLine(tail);
	}

	private parseJsonLine(line: string): Record<string, unknown> | null {
		try {
			const parsed = JSON.parse(line) as unknown;
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	private async probe(
		provider: AiProvider,
		endpoint: string,
		apiKey: string
	): Promise<{ ok: boolean; models: string[] }> {
		try {
			const { models: url } = resolveAiUrls(endpoint, provider);
			const response = await fetch(url, {
				headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
			});
			if (!response.ok) return { ok: false, models: [] };
			const body = (await response.json()) as Record<string, unknown>;
			if (provider === 'ollama') {
				const models = Array.isArray(body.models) ? body.models : [];
				return {
					ok: true,
					models: models
						.filter((m): m is Record<string, unknown> => isRecord(m))
						.map((m) => (typeof m.name === 'string' ? m.name : ''))
						.filter(Boolean)
				};
			}
			const data = Array.isArray(body.data) ? body.data : [];
			return {
				ok: true,
				models: data
					.filter((m): m is Record<string, unknown> => isRecord(m))
					.map((m) => (typeof m.id === 'string' ? m.id : ''))
					.filter(Boolean)
			};
		} catch {
			return { ok: false, models: [] };
		}
	}

	private toInfo(error: unknown): RpcErrorInfo {
		if (error instanceof HostError) return { code: error.code, message: error.message };
		return { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
	}
}
