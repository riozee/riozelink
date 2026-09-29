/**
 * One WebRTC link, host side.
 *
 * The browser is always the one that offers, because it is the one that has something to say
 * first. This side answers, trickles its ICE candidates back, and hands the DataChannel to the
 * host the moment it opens. Nothing about the RPC lives here; a link is just a pipe.
 */
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import type { RelayMessage, RelayOutgoing } from './protocol.ts';

export interface PeerLinkOptions {
	/** `stun:` URLs, when the user configured any. Empty means host candidates only, which is
	 * what a local network pairing wants. */
	iceServers: string[];
	/** Sends one message to the room this peer's link sits in. */
	send(message: RelayOutgoing): void;
	onChannel(channel: RTCDataChannel): void;
	onClosed(reason: string): void;
	log(message: string): void;
}

export interface PeerLink {
	/** Feeds one message from the room. */
	handleSignal(message: RelayMessage): Promise<void>;
	/** The id of the end this peer is talking to, once an offer has arrived. */
	readonly remoteId: string | undefined;
	close(reason?: string): void;
}

export function createPeerLink(options: PeerLinkOptions): PeerLink {
	const peer = new RTCPeerConnection({
		iceServers: options.iceServers.map((urls) => ({ urls })),
		// Loopback is left out of the default gathering. A RiozeOS running on this very machine is
		// a normal setup for trying the link out, so it is asked for explicitly.
		iceAdditionalHostAddresses: ['127.0.0.1', '::1'],
		// What the browser is told it may send us. Browsers clamp their own messages to this, and
		// the default 64 KiB is a needlessly low ceiling for a local network link.
		maxMessageSize: 8 * 1024 * 1024
	});
	let closed = false;
	/** Candidates gathered before the answer went out, waiting for their turn. */
	const buffered: RelayOutgoing[] = [];
	let answerSent = false;
	/**
	 * The id the browser offered with, which every reply is addressed back to. Both ends use it to
	 * tell one attempt from the next, which is what lets a browser that gave up on a lost answer
	 * start over without either side confusing the two.
	 */
	let remoteId: string | undefined;

	function closeOnce(reason: string): void {
		if (closed) return;
		closed = true;
		try {
			void peer.close();
		} catch {
			// Closing an already broken peer is not worth reporting.
		}
		options.onClosed(reason);
	}

	peer.onIceCandidate.subscribe((candidate) => {
		if (closed) return;
		// Gathering's end is not announced. The relay has a frame limit and nothing to do with an
		// empty candidate, so the marker is simply not sent.
		if (!candidate) return;
		const json = candidate.toJSON();
		const frame: RelayOutgoing = {
			type: 'candidate',
			to: remoteId,
			candidate: json.candidate,
			sdpMid: json.sdpMid ?? null,
			sdpMLineIndex: json.sdpMLineIndex ?? null
		};
		// The answer has to arrive before any candidate does. Gathering starts while the answer is
		// still being built, and a browser that is handed a candidate before a remote description
		// throws it away, so the frames wait here for one beat.
		if (!answerSent) {
			buffered.push(frame);
			return;
		}
		options.send(frame);
	});

	peer.connectionStateChange.subscribe((state) => {
		if (state === 'failed' || state === 'closed') closeOnce(`the WebRTC link ${state}`);
	});

	peer.onDataChannel.subscribe((channel) => {
		if (closed) return;
		options.log(`data channel open (${channel.label})`);
		options.onChannel(channel);
	});

	let offered = false;

	async function handleSignal(message: RelayMessage): Promise<void> {
		if (closed) return;
		try {
			if (message.type === 'offer') {
				// One offer is answered once. A repeat of the *same* attempt changes nothing here —
				// the browser re-sends because the answer may have been lost, and the answer it gets
				// for the first offer is the one that counts. An offer from a different sender is a
				// different attempt, and the host decides what to do with that (see `host.ts`).
				if (offered) return;
				offered = true;
				remoteId = message.from;
				await peer.setRemoteDescription({ type: 'offer', sdp: message.sdp ?? '' });
				const answer = await peer.createAnswer();
				await peer.setLocalDescription({ type: 'answer', sdp: answer.sdp });
				options.send({ type: 'answer', to: remoteId, sdp: answer.sdp ?? '' });
				answerSent = true;
				for (const frame of buffered) options.send(frame);
				buffered.length = 0;
				return;
			}
			if (message.type === 'candidate') {
				if (message.candidate === null || message.candidate === undefined) {
					await peer.addIceCandidate(null);
					return;
				}
				await peer.addIceCandidate({
					candidate: message.candidate,
					sdpMid: message.sdpMid ?? undefined,
					sdpMLineIndex: message.sdpMLineIndex ?? undefined
				});
				return;
			}
			// `hello` and `bye` are courtesies the relay cannot provide, and neither moves a handshake.
		} catch (error) {
			options.log(`signaling failed: ${(error as Error).message}`);
			closeOnce('the WebRTC handshake failed');
		}
	}

	return {
		handleSignal,
		get remoteId(): string | undefined {
			return remoteId;
		},
		close: (reason = 'closed by the host') => closeOnce(reason)
	};
}
