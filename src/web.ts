/**
 * The web, fetched by the host.
 *
 * A browser tab cannot frame most of the web. `X-Frame-Options: DENY`, a
 * `frame-ancestors` policy and a page's own `Content-Security-Policy` are exactly the
 * headers that say "not inside a box", and no amount of sandboxing on our side changes
 * them. So the host fetches the page instead: with its own IP, its own network, and no
 * cookie jar of ours to leak. What comes back is a document that is ready to be framed.
 *
 * Only the document travels. Images, stylesheets and scripts keep their real addresses
 * and load straight from their own origins, which is fast and keeps the link for the
 * things only this route can carry. Three small edits are made on the way through:
 *
 *   - a `<base>` tag, so relative URLs resolve against the page that was actually
 *     fetched rather than against riozeOS;
 *   - the policy meta tags are dropped, since they are the reason the page could not be
 *     framed in the first place, and a `http-equiv="refresh"` because it would navigate
 *     the frame away from under us;
 *   - one small script that reports link clicks and form submissions back to the app,
 *     so following a link keeps going through the same route instead of landing on a
 *     page that refuses to draw.
 *
 * The page is decoded with the charset it declares and re-encoded as UTF-8, so a page
 * that says `shift_jis` still reads correctly on the other side.
 */
import { HostError } from './errors.ts';

/** How long one page may take before the fetch is given up on. */
export const WEB_TIMEOUT_MS = 20_000;
/** How big one page may get. Past this it is cut, and the app says so. */
export const WEB_MAX_BYTES = 4 * 1024 * 1024;
/** How many pages one session keeps in memory. */
export const WEB_MAX_PAGES = 4;

export interface WebPage {
	/** Where the fetch actually ended, redirects included. */
	url: string;
	title: string | null;
	contentType: string;
	/** The document, UTF-8, ready to be framed. */
	html: Uint8Array;
	truncated: boolean;
}

/** What a pair of response headers says about framing, if anything. */
export interface FramingVerdict {
	/** The header that would keep this page out of a frame, or null when nothing would. */
	framing: 'x-frame-options' | 'frame-ancestors' | null;
	/** The header's own value, so a failure can name the rule that caused it. */
	detail: string | null;
	status: number;
}

/**
 * What the injected script talks to. It is deliberately tiny and dependency-free, and it
 * only ever reports: the app decides what a click means.
 */
const BRIDGE_SCRIPT = `<script data-rioze-link="bridge">
(function () {
  if (window.__riozeLinkBridge) return;
  window.__riozeLinkBridge = true;
  var send = function (payload) {
    try { parent.postMessage(payload, '*'); } catch (error) { void error; }
  };
  document.addEventListener('click', function (event) {
    var node = event.target;
    while (node && node.nodeType === 1) {
      if (node.tagName === 'A') {
        var href = node.getAttribute('href') || '';
        if (href && href.charAt(0) !== '#') {
          event.preventDefault();
          try { send({ source: 'rioze-link', kind: 'navigate', url: new URL(href, document.baseURI).href }); } catch (error) { void error; }
        }
        return;
      }
      node = node.parentNode;
    }
  }, true);
  document.addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.target;
    var action = '';
    try { action = new URL(form.getAttribute('action') || '', document.baseURI).href; } catch (error) { void error; }
    send({ source: 'rioze-link', kind: 'submit', url: action, method: (form.getAttribute('method') || 'get').toLowerCase() });
  }, true);
})();
</script>`;

/** Strips the tags that would stop this document from being framed at all. */
function stripBlockingMeta(html: string): string {
	return html
		.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
		.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, '');
}

/** `&amp;` and friends, for the one place a title is taken out of markup. */
function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

function titleOf(html: string): string | null {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match) return null;
	const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
	return title ? title.slice(0, 200) : null;
}

/** The charset the server declared, in a form `TextDecoder` understands. */
function charsetOf(contentType: string): string {
	const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
	return (match?.[1] ?? 'utf-8').toLowerCase();
}

/** Rewrites (or adds) the document's own charset declaration, so it stays true. */
function forceUtf8Meta(html: string): string {
	if (/<meta\b[^>]*charset\b[^>]*>/i.test(html)) {
		return html.replace(/<meta\b[^>]*charset\b[^>]*>/i, '<meta charset="utf-8">');
	}
	return html;
}

/**
 * The whole edit, in one pass. `<base>` goes first in the head so every relative URL in the
 * document resolves correctly, and the bridge script goes last so it never delays the page.
 */
function prepareHtml(html: string, finalUrl: string): string {
	const cleaned = forceUtf8Meta(stripBlockingMeta(html));
	const base = `<base href="${finalUrl.replace(/"/g, '&quot;')}">`;
	const withBase = /<head[^>]*>/i.test(cleaned)
		? cleaned.replace(/<head[^>]*>/i, (tag) => `${tag}${base}`)
		: `${base}${cleaned}`;
	return /<\/body>/i.test(withBase)
		? withBase.replace(/<\/body>/i, `${BRIDGE_SCRIPT}</body>`)
		: `${withBase}${BRIDGE_SCRIPT}`;
}

/**
 * Fetches one page and prepares it for framing. Throws a `HostError` with a code the app can
 * act on: `invalid` for a URL that is not http(s), `unsupported` for a body that is not a
 * document, `offline` when the site does not answer, `io` for anything else.
 */
export async function fetchPage(rawUrl: string): Promise<WebPage> {
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		throw new HostError(`that is not a URL: ${rawUrl}`, 'invalid');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new HostError(`only http and https can be fetched, not ${url.protocol}`, 'invalid');
	}

	let response: Response;
	try {
		response = await fetch(url, {
			redirect: 'follow',
			signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
			headers: {
				// The page is being read by a person, so it is asked for the way a browser
				// would ask. A bare tool user agent gets a challenge page on half the web.
				'user-agent':
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 RiozeLink/0.4',
				accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'accept-language': 'en;q=0.9,*;q=0.5'
			}
		});
	} catch (error) {
		const message = (error as Error)?.message ?? 'the fetch failed';
		const timedOut = /timed out|timeout|abort/i.test(message);
		throw new HostError(
			timedOut
				? `${url.host} took longer than ${WEB_TIMEOUT_MS / 1000}s to answer`
				: `${url.host} could not be reached (${message})`,
			'offline'
		);
	}

	const contentType = response.headers.get('content-type') ?? '';
	const finalUrl = response.url || url.href;
	const isDocument = /text\/html|application\/xhtml\+xml/i.test(contentType);
	if (!isDocument) {
		const short = contentType.split(';')[0] || 'nothing';
		throw new HostError(
			`${url.host} answered with ${short}, which is not a page this can show`,
			'unsupported'
		);
	}

	let bytes = new Uint8Array(0);
	let truncated = false;
	if (response.body) {
		const reader = response.body.getReader();
		const parts: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const room = WEB_MAX_BYTES - total;
			if (value.byteLength >= room) {
				parts.push(value.subarray(0, room));
				total += room;
				truncated = true;
				await reader.cancel().catch(() => undefined);
				break;
			}
			parts.push(value);
			total += value.byteLength;
		}
		bytes = new Uint8Array(total);
		let at = 0;
		for (const part of parts) {
			bytes.set(part, at);
			at += part.byteLength;
		}
	} else {
		bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > WEB_MAX_BYTES) {
			bytes = bytes.subarray(0, WEB_MAX_BYTES);
			truncated = true;
		}
	}

	// The document is decoded with the charset it declared and stored as UTF-8, so a page
	// that ships as shift_jis still reads correctly on the other side.
	let text: string;
	try {
		text = new TextDecoder(charsetOf(contentType), { fatal: false }).decode(bytes);
	} catch {
		text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	}

	const prepared = prepareHtml(text, finalUrl);
	return {
		url: finalUrl,
		title: titleOf(text),
		contentType,
		html: new TextEncoder().encode(prepared),
		truncated
	};
}

/**
 * Reads one page's headers and nothing else, to answer the one question the browser cannot
 * answer for itself: would this page be allowed to sit in a frame?
 *
 * A frame that refuses to draw looks exactly like a frame that drew nothing, and a refusal is
 * fast, so the app used to guess from load time alone. That guess fires on small pages too, and
 * swapping a page that is already readable for a fetched copy of itself is worse than waiting a
 * moment longer. The host can simply look: `X-Frame-Options` and a `frame-ancestors` policy are
 * the two rules that decide it, and both travel in the response headers.
 *
 * The body is never read. A fetch is asked for and cancelled at the headers, which keeps this
 * cheap enough to run on every suspicious load.
 */
export async function probeFraming(rawUrl: string): Promise<FramingVerdict> {
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		throw new HostError(`that is not a URL: ${rawUrl}`, 'invalid');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new HostError(`only http and https can be fetched, not ${url.protocol}`, 'invalid');
	}

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'GET',
			redirect: 'follow',
			signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
			headers: {
				'user-agent':
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 RiozeLink/0.4',
				accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'accept-language': 'en;q=0.9,*;q=0.5'
			}
		});
	} catch (error) {
		const message = (error as Error)?.message ?? 'the fetch failed';
		const timedOut = /timed out|timeout|abort/i.test(message);
		throw new HostError(
			timedOut
				? `${url.host} took longer than ${WEB_TIMEOUT_MS / 1000}s to answer`
				: `${url.host} could not be reached (${message})`,
			'offline'
		);
	}
	// The verdict lives in the headers, so the body is not wanted at all.
	await response.body?.cancel().catch(() => undefined);

	const xfo = response.headers.get('x-frame-options');
	if (xfo) {
		return {
			framing: 'x-frame-options',
			detail: `X-Frame-Options: ${xfo.trim()}`,
			status: response.status
		};
	}
	const csp = response.headers.get('content-security-policy');
	const ancestors = csp ? /(?:^|;)\s*frame-ancestors\s*([^;]*)/i.exec(csp) : null;
	if (ancestors) {
		const value = ancestors[1].trim();
		// `frame-ancestors *` is the one value that permits anything, including us.
		if (value && value !== '*') {
			return {
				framing: 'frame-ancestors',
				detail: `Content-Security-Policy: frame-ancestors ${value}`,
				status: response.status
			};
		}
	}
	return { framing: null, detail: null, status: response.status };
}
