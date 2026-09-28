/**
 * One WebRTC link, host side.
 *
 * The browser is always the one that offers, because it is the one that has something to say
 * first. This side answers, trickles its ICE candidates back, and hands the DataChannel to the
 * host the moment it opens. Nothing about the RPC lives here; a link is just a pipe.
 */
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import type { SignalPayload } from './protocol.ts';

export interface PeerLinkOptions {
	/** `stun:` URLs, when the user configured any. Empty means host candidates only, which is
	 * what a local network pairing wants. */
	iceServers: string[];
	/** Sends an outgoing signal frame to the browser. */
	send(data: SignalPayload): void;
	onChannel(channel: RTCDataChannel): void;
	onClosed(reason: string): void;
	log(message: string): void;
}

export interface PeerLink {
	/** Feeds one incoming frame from the browser. */
	handleSignal(data: SignalPayload): Promise<void>;
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
		if (!candidate) {
			options.send({ type: 'candidate', candidate: null });
			return;
		}
		options.send({ type: 'candidate', candidate: candidate.toJSON() });
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

	async function handleSignal(data: SignalPayload): Promise<void> {
		if (closed) return;
		try {
			if (data.type === 'offer') {
				if (offered) return;
				offered = true;
				await peer.setRemoteDescription({ type: 'offer', sdp: data.sdp });
				const answer = await peer.createAnswer();
				await peer.setLocalDescription({ type: 'answer', sdp: answer.sdp });
				options.send({ type: 'answer', sdp: answer.sdp });
				return;
			}
			if (data.type === 'candidate') {
				if (!data.candidate) {
					await peer.addIceCandidate(null);
					return;
				}
				await peer.addIceCandidate({
					candidate: data.candidate.candidate,
					sdpMid: data.candidate.sdpMid,
					sdpMLineIndex: data.candidate.sdpMLineIndex
				});
			}
		} catch (error) {
			options.log(`signaling failed: ${(error as Error).message}`);
			closeOnce('the WebRTC handshake failed');
		}
	}

	return { handleSignal, close: (reason = 'closed by the host') => closeOnce(reason) };
}
