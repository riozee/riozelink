# The relay

RiozeLink never asks for an address, so the two ends need somewhere to meet. That is all this is: a
tiny Cloudflare Worker that holds a room with two WebSockets in it and passes introductions between
them. It cannot read a file, a phrase, or a message. A room name is a hash, the payloads are SDP and
ICE, and everything a person actually cares about travels between the two peers over an encrypted
DataChannel that never touches this code.

Deploy it once, keep the URL, and forget about it.

## Deploy

```bash
cd relay
bun install
bun run deploy
```

Wrangler prints the URL it created, something like `https://riozelink-relay.<you>.workers.dev`. The
browser talks to it over `wss://`, and `wss://` needs `https://` underneath, so replace the scheme:

```
https://riozelink-relay.example.workers.dev   →   wss://riozelink-relay.example.workers.dev
```

Point the daemon at it:

```bash
riozeLink --relay wss://riozelink-relay.example.workers.dev
```

and type the same URL into RiozeLink's pairing screen under *Meeting point*. A custom domain works
just as well (`relay.rioze.dev`, for instance) and is what the default points at.

## What it costs

Nothing on the free plan. Rooms are evicted the moment they empty, messages are a few hundred bytes
of SDP, and there is no storage: the Durable Object holds two sockets and no state that survives the
conversation.

## Do I have to use Cloudflare?

No. The same protocol is implemented in the daemon itself, so any machine you can reach over the
network can be the meeting point:

```bash
riozeLink relay --port 4400      # on a box with a public name
riozeLink --relay wss://that-box:4400
```

The protocol is a handful of JSON frames: `join` a room with a role, get `joined`, forward `signal`
to the other member, notice `peer` arrivals and departures, answer `ping` with `pong`. If you are
reading this because you want to write your own relay in another language, that is the whole spec —
and it is worth reading `src/relay-server.ts` or `src/index.ts` here, both of which are under a
hundred and fifty lines.

## House rules

- Two sockets per room. A third join is refused, which is what makes an eavesdropper on a pairing
  room impossible rather than merely unlikely.
- Forty joins per room per minute, so nobody can walk a phrase list through the relay.
- Nothing is logged about a room. No room names, no payloads, no addresses.
