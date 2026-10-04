# RiozeLink

**Your computer's files and services, reachable from [riozeOS](https://rioze.dev) in the browser.**

English · [日本語](README.ja.md)

RiozeLink is a small daemon you run on your own computer. It opens one private, encrypted link to
riozeOS in the browser, and over that link RiozeOS can browse folders you chose to share, talk to
AnkiConnect, and send AI chats through Ollama or an OpenAI-compatible endpoint with your own key.
Nothing needs an account, and nothing needs a port to be open on your router. The daemon joins a room
on a relay that both ends know how to name, and waits there for your browser to walk in.

```text
 your computer                          the browser
┌──────────────────────┐              ┌──────────────────────┐
│  ~/Notes      ───────┼── WebRTC ────┼─► /riozeos/drives/   │
│  AnkiConnect  ───────┼── encrypted ─┼─► notes              │
│  Ollama       ───────┼── DataChannel┼─► Anki panel         │
│  API key (0600)      │      ▲       │   AI panel           │
└──────────────────────┘      │       └──────────────────────┘
                              │                    riozeOS app
                 a relay introduces the two once
                 (a pairing code, then never again)
```

## Why people run it

- **Real files.** A folder on your computer shows up as a drive inside riozeOS. Read it, write it,
  rename it, delete it. riozeOS stores its own files in the browser, and the browser can clear that
  storage at any time. A shared folder is your disk, so it stays where you put it.
- **Anki without a plugin war.** AnkiConnect only listens on your machine's loopback interface. The
  daemon is already on that machine, so it forwards the calls and riozeOS gets your decks.
- **AI where your models live.** Ollama runs on your computer. Your OpenAI key stays on your
  computer too, written to a file only you can read, and riozeOS never sees more than `sk-...1234`.

## Requirements

- [Bun](https://bun.sh) 1.2 or newer. The daemon is TypeScript that Bun runs directly.
- A riozeOS instance in any browser, anywhere. The two do not have to be on the same network.
- Optional: Anki with the [AnkiConnect](https://foosoft.net/projects/anki-connect/) add-on, and
  [Ollama](https://ollama.com) if you want local models.

## Install

```sh
git clone https://github.com/riozee/riozelink.git
cd riozelink
bun install
```

Try it without installing anything:

```sh
bun run start
```

That starts the daemon in place. When you want `riozelink` on your `PATH`:

```sh
bun link
```

Or install straight from GitHub:

```sh
bun install -g github:riozee/riozelink
```

## First run, step by step

**1. Start the daemon.**

```sh
riozelink
```

The terminal paints a small panel with everything the next step needs.

```text
RIozeLink 0.3.0 · listening
code     HONEST LOBSTER BANANA DUNE 6YRB (2m 41s left)
clients  no clients yet
shares   none yet
config   ~/.config/riozelink/config.json
```

**2. Share a folder.** Either from the panel's other terminal or from the riozeOS app later.

```sh
riozelink folders add ~/Notes --label Notes
```

**3. Connect riozeOS.** The panel already has a code on it, because one is minted for you at
startup. Open riozeOS, start the **RiozeLink** app, type that code in, and press Connect. That is
the entire setup. No address to copy, no port to open, and nothing that has to be read twice to be
sure of it. If the code has lapsed, press `n` on the panel for a fresh one.

What happens under the hood, in order:

1. The code names a room. Both the daemon and the browser stretch it with PBKDF2 into the same room
   name, and each joins it on the relay. The relay sees that name and never the code, and working
   back from the name to the code costs a hundred thousand rounds per guess rather than one hash.
2. The browser generates an ECDSA P-256 key pair and keeps the private half non-extractable in
   IndexedDB. It never leaves the browser.
3. The two sides swap a WebRTC offer and answer through the relay. This is only an introduction.
   The conversation itself runs over the DataChannel, encrypted by DTLS, and the relay is done
   with you.
4. Over that channel the browser sends `auth:hello`. The daemon answers with its own public key, a
   nonce, and a signature over the browser's nonce. The client verifies it, so it knows it found
   your daemon and not something else that answered on the way.
5. For the first pairing the browser must also prove it knows the code: it stretches it with
   PBKDF2 into a key and sends an HMAC of the daemon's nonce. The code itself never crosses the
   wire. The same message carries a signature from the browser's key, so the key being stored is
   the key being used.
6. The daemon checks both, writes the browser's fingerprint into `authorizedClients`, and retires
   the code on the spot. The room it named comes down with it, and nothing takes its place until
   somebody asks for another one.

**4. Use it.** The shared folder appears in the riozeOS File Explorer under `/riozeos/drives/remote-notes`.
Every read and write you make there lands on the folder you picked.

## Everyday use

### Reconnecting

Open the app in riozeOS and press Connect. There is nothing to type. The browser and the daemon
join a room named by both their fingerprints, a name only those two can compute, and the
browser proves itself with the key it stored during pairing. The daemon's identity survives
restarts, the browser remembers its fingerprint from the first pairing, and a different machine
under that name is refused.

### Sharing more folders

From the terminal:

```sh
riozelink folders add ~/Documents/recipes
riozelink folders list
riozelink folders remove recipes
```

From riozeOS, the RiozeLink app's **Drives** tab does the same things over the link. An authorized
client is allowed to add folders. That is a real permission, so treat the pairing like giving
someone a key to the machine. Remove a client from `authorizedClients` in the config file and
restart the daemon to take it back.

### Anki

Turn the integration on in the app's **Anki** tab or in the config file. It is off until you ask. While
it is on, the daemon probes `127.0.0.1:8765` every five seconds and tells every connected RiozeOS the
moment Anki opens or closes, so the indicator in the app lights up on its own. While it is off, the
daemon refuses with `denied`, even for a paired client.

Nothing about your collection is stored anywhere. The calls are proxied and forgotten.

### AI

The **AI** tab has a toggle of its own, off until you turn it on, and then two providers.

- **Ollama.** The endpoint defaults to `http://127.0.0.1:11434`. No key. Chats stream back token by
  token. A pasted address that already carries `/v1`, `/api` or `/api/chat` still works, because
  the path is only added where it is missing.
- **OpenAI-compatible.** Any endpoint that speaks `/v1/chat/completions` with `stream: true`
  works, including self-hosted gateways. A bare host, a base that already carries its version
  (`https://api.deepseek.com/v1`) and the full chat URL are all accepted the same way. The key is
  sent once over the encrypted channel, written to `config.json` with `0600` permissions, and only
  ever read back in masked form.

Switching providers replaces the address and the model with the new provider's defaults, so one
provider's address never leaks into the other.

**Images are off until you say otherwise.** Few models take pictures, and a screenshot spends a
model's budget quickly, so `ai.images` starts false and the StudyDoc assistant renders its page for
your eyes only. Flip it on and the same tool attaches a smaller JPEG copy to the conversation. The
daemon maps that onto `image_url` parts for an OpenAI-compatible endpoint and onto `images` entries
for Ollama. One image may carry up to 200,000 base64 characters, and a model whose settings say it
takes text only gets a clear refusal rather than a malformed request.

Setting a key is a write-only affair: the app opens a dialog, sends the key, and shows
`sk-...1234` from there on. To replace one, use **Set a new key**. To remove one, use **Clear**.

### Carrying a whole session

The Browser in riozeOS cannot frame most of the web. `X-Frame-Options` and a `frame-ancestors`
policy are refusals an embedder has no vote in, and a sandboxed frame with no storage of its own
cannot hold a login even when a page does load. So there is one switch, `tunnel.enabled`, and it is
a big permission: while it is on, the Browser runs a real rewriting proxy and **every request of a
whole browsing session** comes down this link. The proxy itself never touches this machine's
filesystem or the browser's storage; it is code served from an origin of its own, and this daemon is
only the pipe underneath it.

One exchange is four small messages plus some events. `tunnel:open` names the request and is
answered when the response headers arrive, `tunnel:body` supplies the request's bytes when there
are any, `tunnel:ack` says the browser took delivery of bytes already sent, and `tunnel:abort`
says the page walked away. The response streams back as `tunnel:chunk` events ending in
`tunnel:end`, or in `tunnel:error` when something fails after the headers. Slices are the same
45 KiB a file uses, and the flow-control window is a window rather than a limit: once 512 KiB are
unacknowledged the fetch stops reading, so a page that stops consuming slows this machine instead
of filling a buffer nobody is watching.

Three decisions are worth knowing. **No cookie jar**: cookies ride in the request headers the
client sends and come back in `set-cookie` untouched, because the browser's proxy keeps the jar
and a second copy here would be a second truth about who you are. **No redirect following**: a 3xx
is handed back with its `location`, and the proxy follows the chain itself, hop by hop through this
same tunnel, which is what keeps every destination a rewritten page like any other. **The body is
decoded here**: this runtime decompresses on the way through, so `content-encoding` and
`content-length` are dropped rather than passed on as a lie. Framing headers (`x-frame-options`, a
`content-security-policy`) are stripped at both ends.

It defaults to **off**, and the Browser cannot turn it on by itself: a press on its own toggle while
this says no explains where the switch is. With it off, every `tunnel:` action but the toggle
answers `denied`, and the moment the switch moves the daemon tells every connected browser, so an
armed runtime is put away at once rather than at its next poll. The honest limits: WebSockets are
not carried yet, request bodies are assembled before the fetch starts, and a site that challenges
proxies will challenge this one too.

## The configuration file

`~/.config/riozelink/config.json`, created on first start. It is meant to be edited by hand, and
anything unreadable falls back to its default rather than breaking the daemon.

```json
{
	"version": 1,
	"hostName": "rioze-macbook",
	"folders": {
		"notes": { "label": "Notes", "path": "/Users/rioze/Notes" }
	},
	"anki": { "enabled": false, "port": 8765 },
	"ai": {
		"enabled": false,
		"provider": "ollama",
		"endpoint": "http://127.0.0.1:11434",
		"model": "llama3.2",
		"apiKey": ""
	},
	"tunnel": { "enabled": false },
	"authorizedClients": {
		"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08": {
			"label": "Browser",
			"pairedAt": 1789000000000
		}
	}
}
```

`identity.json` lives next to it and holds the daemon's own key pair. Keep it. Replacing it means
every browser has to pair again, because the fingerprint they pinned is gone.

Set `RIOZELINK_CONFIG_DIR` to move both files somewhere else, which is also how the tests keep
their hands off a real home directory.

## Commands

| Command                                         | What it does                                               |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `riozelink`                                     | Starts the daemon and the terminal panel.                  |
| `riozelink --stun stun:stun.l.google.com:19302` | Adds STUN servers, for links behind stubborn NATs.         |
| `riozelink --quiet`                             | Prints the code once, then only log lines.                 |
| `riozelink folders list`                        | Shows the shared folders.                                  |
| `riozelink folders add <path> [--label Notes]`  | Shares a folder.                                           |
| `riozelink folders remove <id>`                 | Stops sharing one.                                         |
| `riozelink clients list`                        | Shows the browsers this daemon remembers.                  |
| `riozelink clients revoke <name>`               | Forgets one, name and all.                                 |
| `riozelink status`                              | A summary of the config file, clients included.            |

On the panel, `n` mints a pairing code, `h` shows the first-connection notes, and `q` stops the
daemon. A daemon running with no panel does the same job on `SIGUSR2`.

## The meeting point

Two ends have to be introduced before WebRTC can take over, and neither can be asked for an address.
So both ends join a *room* on a relay and talk to whoever else is in it. A browser holding the four
words derives the same room name the daemon did, joins it, and offers into it. Reconnecting later
needs no words at all, because the room both sides compute from their fingerprints is one nobody
else can name.

The relay is `wss://signal.rioze.dev`, one fixed machine that every installation shares. It is not a
setting, and there is no flag, field or file that can point a daemon somewhere else. Writing one was
tempting, and leaving it out is the better answer. A meeting point has value only while both ends
can reach it, and the reason a link works the first time is that nobody has to agree on where to
meet. The app and the panel therefore say nothing about it, because there is nothing about it to get
wrong.

Two ends in a room address each other rather than guessing. The relay hands each frame to everyone
in the room except the sender, and it never says who is in there, so `from` says who sent it and
`to` says who it is for. That is enough for a handshake, and it is all the relay ever learns.

Two rules come with it. Frames are text, capped at 64 KiB of UTF-8, and a frame over that cap closes
the socket with `1009`. A closed socket is a lost link, so both ends check the size before sending
and drop a frame that would not fit instead of taking the room down over it.

One honest limitation. There is no TURN server anywhere in this setup. TURN is the piece that
carries the traffic itself when two peers cannot find a direct path to each other, which is what
happens when both networks use symmetric NAT or carrier-grade NAT. On a home network, on a phone
hotspot, or with the two ends on one machine, a direct path exists and everything works. On two
unfriendly networks it can simply fail, and the app will say the channel did not open. Putting both
devices on one hotspot is the workaround that always works, and running a TURN server is the real
fix when this starts to matter. It is left out on purpose for now, because it is the one part of
this design that costs money to run.

## How it works

### The pieces

| Piece         | Where it lives                 | What it does                                                                                                                 |
| ------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| The code      | `src/words.ts`                 | 534 plain words and Crockford's 32 characters. Four of each, about 56 bits, no confusable pairs.                             |
| The relay     | `src/signal.ts`                | One socket per room, frames taken verbatim, reconnects with backoff.                                                        |
| WebRTC link   | `src/peer.ts`                  | Answers the browser's offer, trickles candidates, hands over the DataChannel.                                                |
| Auth          | `src/session.ts`               | Hello, proof, pairing. Every other message waits behind it.                                                                  |
| Filesystem    | `src/vfs.ts`, `src/sandbox.ts` | Path fence, chunked reads and writes, part files, change watching.                                                           |
| Anki          | `src/anki.ts`                  | One toggle, a five-second probe, and a POST to the loopback.                                                                 |
| AI            | `src/ai.ts`                    | Two dialects, one streaming shape, keys stay here.                                                                           |
| Tunnel        | `src/tunnel.ts`                | One `fetch` per exchange, the response sliced back to the browser, no cookie jar and no redirect following.                                |
| Wire contract | `src/protocol.ts`              | The one file both sides build their clients and their dispatchers from. Peer ids and the pairing proof are derived here too. |

The riozeOS side lives in the riozeOS repository as the `com.riozelink.svelte` app. Its remote
backend implements the same `VfsBackend` interface the local filesystem does, so the File Explorer
does not know or care that a drive is far away.

### The life of one file read

1. riozeOS asks its filesystem layer for `/riozeos/drives/notes/sub/list.txt`.
2. The mount table sees the path sits inside a mounted remote drive and hands the request to the
   remote backend with the prefix stripped. The backend sees `/sub/list.txt`.
3. The backend sends `vfs:read` with the share id and an offset, and asks for at most 45 KB.
4. The daemon normalizes the path, walks it up to the deepest existing part, asks the OS for that
   part's real location, and refuses the whole call if the real location is outside the shared
   folder. Symlinks cannot smuggle anything out.
5. The daemon reads the slice, base64-encodes it, and answers. The client keeps asking until a
   reply says `done`.

45 KB per message is not a round number on purpose. Base64 grows it by a third, and the result has
to stay under the 64 KB message size some WebRTC stacks advertise. Chunks that fit everywhere beat
chunks that are fast on paper.

### The life of one file write

Writes are the careful direction. Each slice lands in a hidden part file named
`<name>.riozelink-part-<id>` in the same folder as the target. The real file is not touched until
the final slice arrives, and the final step is one rename, which either happens or does not. An
interrupted upload therefore cannot leave a half file where the user believes in it.

Part files are invisible to clients and are removed when the session that owned them goes away. A
daemon that is killed mid-upload can leave one behind. The next start sweeps those older than an
hour.

### Reconnects and identity

The daemon generates its own ECDSA P-256 key pair on first start, in `identity.json`. The browser
pins the fingerprint it sees during the first pairing and re-checks it on every connection, which is
why a different machine cannot quietly take over.

Returning needs no code because the room both ends join is proof enough of who belongs there. They
hash their two public fingerprints together, and only those two can arrive at that name. The daemon
sits in one such room per paired browser and nothing else, so a client it has never met has nowhere
to knock.

### The pairing code

A code is four words from a list of 534 words, then four characters from Crockford's Base32 alphabet.
The words are about 36 bits and the tail adds 20 more, and the alphabet leaves out `I`, `L`, `O` and
`U`, so the two characters a person actually confuses, `O` with `0` and `I` with `1`, can never both
appear. It is short enough to read off a terminal and type on a phone without going back to check.

The code does three jobs at once. It is what a person reads, it names the room, and it is the secret
that proves the person was at that terminal.

The proof is an HMAC through a PBKDF2-stretched key, so the code itself never crosses the wire in
either direction. The room name gets the same treatment, and that one matters more than it looks.
The room name is the single thing here that gets published, because the daemon writes it into the
socket URL the relay reads. A plain hash at that spot would let whoever read the name test the whole
code space offline at hash speed. Stretching it costs the same hundred thousand rounds, once per
connection, which is affordable.

A code is minted, never standing. One is made at startup and one whenever you ask for another, it
lives for three minutes, and nothing renews it. Ten wrong tries spend it early, and it retires the
moment a browser pairs with it. Between those moments the daemon sits only in the rooms it shares
with browsers it already knows, so there is nothing for a stranger to find and nothing worth
guessing at while nobody is being let in.

Asking for another one means pressing `n` on the panel, or sending `SIGUSR2` to the daemon when
there is no panel to press. Minting is deliberately not a subcommand. The only way a command could
reach a running daemon is a local socket, and a socket that hands out pairing codes would hand them
to every other process on the machine, which is the one guarantee this design is built on.

### Several browsers at once

One daemon serves several riozeOS instances at the same time. Each connection becomes its own
session with its own auth state, its own upload part files, and its own AI streams. The daemon
never introduces one client to another. The only thing that is shared is a number, the count of
connected clients, and that is all any client can learn about the others.

### Watching for changes

Each shared folder is watched on the host. Changes are batched for a quarter of a second and pushed
to every connected client as `vfs:changed` events. `fs.watch` cannot tell a create from a delete,
so a rename event is answered with a `stat`, and the name exists now means it appeared. A pure
rename shows up as a removal and a creation, which is true from where the client sits.

## Security, honestly

The link is private by construction. The DataChannel is encrypted with DTLS between the two peers,
so the relay only ever carries introductions. Every session has to pass the auth exchange before any
other message is answered, and both sides sign a nonce the other side chose, so a replay or a
machine-in-the-middle does not get in. A pairing also has to prove the code, which is what stops
someone who wandered into the right room.

What the daemon will never do, no matter who asks:

- Touch a path outside the folders you shared.
- Run a shell command, open a port, or scan your network.
- Return an API key in any form other than a mask.
- Write its own files anywhere but the config directory.

What is worth knowing:

- An authorized client can add new folders to share and turn Anki on. That is the feature, but it
  is also reach. Revoke a client with `riozelink clients revoke <name>` and restart the daemon.
- Turning the browsing tunnel on spends this machine's network for a whole session, not one page,
  and every byte of it passes through the daemon. What the daemon still does not keep is a cookie
  jar, a redirect chain, or a response the browser stopped reading, and what it will not do is
  reach into the browser's storage, where the logins actually live.
- The pairing code is a secret while it lasts, and it does not last long. Pair from a terminal you
  are looking at, and do not read the code out to anyone you would not hand a key to.
- The relay sees that two connections met in some room. It does not see the code, the files, the
  chats, or the keys, and it never learns who else is in the room with them. It is someone else's
  machine, so treat it as one more party that can watch introductions, and know that the room name
  it reads is a stretched one and not the code.
- The config file holds your API key in plain text. It is written with permissions for your user
  only, which protects it from other accounts, not from you.

## Troubleshooting

**"Pairing failed. Check the code on the host and try again."** A code expires after three minutes and
retires the moment another device uses it. Look at the panel. If that line says none, press `n` for
a fresh one, then try the code it shows.

**Nothing happens when the code is typed.** The two ends meet in a room on a relay. If the daemon
cannot reach `wss://signal.rioze.dev`, check its log for a retry line. A relay that is briefly
unreachable is the usual reason, and the daemon comes back to it on its own.

**The app says the channel did not open.** The two peers found each other but could not build a
direct path, which usually means both networks are behind symmetric NAT or carrier-grade NAT, and
there is no TURN server to fall back on. Putting both devices on one hotspot is the reliable
workaround. A STUN server can help on odd networks too, so `--stun stun:stun.l.google.com:19302` is
worth a try before giving up on a link.

**Anki says it is not reachable.** AnkiConnect has to be installed in Anki and Anki itself has to
be open. The default port is 8765 and can be changed in both AnkiConnect's settings and
`config.json`. The daemon probes every five seconds while the toggle is on, so opening Anki lights
the indicator up on its own.

**The AI endpoint says nothing is listening.** For Ollama, `ollama serve` has to be running and the
model in `config.json` has to be pulled already. The gateway also has its own toggle, off by
default. When the endpoint answers the probe but a chat still comes back 404, the model name is the
thing to check, and the AI tab lists the names the endpoint reported.

**A file operation answers `permission` or `denied`.** The path left the shared folder, possibly
through a symlink, or the host itself does not have the permission. Both are the fence working.

**Two daemons are running.** Nothing stops a second copy that shares a config directory. The two share
one identity, so they join the same rooms, and a browser offering into one may get an answer from
either. Stop the other copy, or point this one somewhere else with `RIOZELINK_CONFIG_DIR`.

## Development

```sh
bun run start   # run the daemon
bun test        # the end to end suite
bun run check   # types
```

The tests are the reference client. They start a real relay and a real daemon on free ports with a
temporary config directory, connect real WebRTC peers, pair with the actual code, and then exercise
the rooms, the filesystem, path refusals, symlink escapes, Anki forwarding against a local fake, and
AI streaming against a fake Ollama that answers one word per chunk. If the daemon satisfies that
suite, it satisfies the browser, because both only ever meet at `src/protocol.ts`.
