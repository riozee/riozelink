/**
 * AnkiConnect, forwarded.
 *
 * Anki desktop only listens on the loopback interface, which is exactly why this daemon exists:
 * the browser cannot reach `127.0.0.1:8765` on the machine RiozeOS is running on, but the daemon
 * on the user's computer can. The whole integration is a gate (the user's toggle) and a POST.
 */
import type { HostConfig } from './config.ts';
import { HostError, requireString } from './errors.ts';
import type { AnkiInvokeReply, AnkiStatusReply } from './protocol.ts';

export interface AnkiHost {
	config: HostConfig;
	save(): Promise<void>;
}

const PROBE_TIMEOUT_MS = 1500;
const INVOKE_TIMEOUT_MS = 20000;

export class AnkiService {
	constructor(private readonly host: AnkiHost) {}

	async status(): Promise<AnkiStatusReply> {
		const { enabled, port } = this.host.config.anki;
		if (!enabled) return { enabled, reachable: false, version: null };
		try {
			const result = await this.call('version', undefined, 6, PROBE_TIMEOUT_MS);
			return { enabled, reachable: true, version: typeof result === 'number' ? result : 6 };
		} catch (error) {
			return {
				enabled,
				reachable: false,
				version: null,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	async setEnabled(enabled: boolean): Promise<AnkiStatusReply> {
		this.host.config.anki.enabled = enabled === true;
		await this.host.save();
		return this.status();
	}

	async invoke(payload: Record<string, unknown>): Promise<AnkiInvokeReply> {
		if (!this.host.config.anki.enabled) {
			throw new HostError('Anki is turned off in riozelink', 'denied');
		}
		const action = requireString(payload.action, 'action');
		const version = typeof payload.version === 'number' ? payload.version : 6;
		const result = await this.call(action, payload.params, version, INVOKE_TIMEOUT_MS);
		return { result };
	}

	private async call(
		action: string,
		params: unknown,
		version: number,
		timeoutMs: number
	): Promise<unknown> {
		const port = this.host.config.anki.port;
		const url = `http://127.0.0.1:${port}`;
		let response: Response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, version, params }),
				signal: AbortSignal.timeout(timeoutMs)
			});
		} catch (error) {
			const cause = (error as Error & { cause?: NodeJS.ErrnoException }).cause;
			if ((error as Error).name === 'TimeoutError') {
				throw new HostError(`AnkiConnect did not answer on 127.0.0.1:${port}`, 'offline');
			}
			if (cause?.code === 'ECONNREFUSED') {
				throw new HostError(`nothing is listening on 127.0.0.1:${port}. Is Anki open?`, 'offline');
			}
			throw new HostError(`could not reach AnkiConnect: ${(error as Error).message}`, 'offline');
		}
		let body: { result?: unknown; error?: string };
		try {
			body = (await response.json()) as { result?: unknown; error?: string };
		} catch {
			throw new HostError(`AnkiConnect answered something that is not JSON`, 'io');
		}
		if (typeof body.error === 'string' && body.error) {
			throw new HostError(`AnkiConnect: ${body.error}`, 'io');
		}
		return body.result;
	}
}
