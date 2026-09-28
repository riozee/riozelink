# RiozeLink

**Your computer's files and services, reachable from [riozeOS](https://rioze.dev) in the browser.**

English · [日本語](README.ja.md)

RiozeLink is a small daemon you run on your own computer. It opens one private, encrypted link to
riozeOS in the browser, and over that link RiozeOS can browse folders you chose to share, talk to
AnkiConnect, and send AI chats through Ollama or an OpenAI-compatible endpoint with your own key.
Nothing needs an account, and nothing needs a port to be open on your router. The daemon dials out
to a tiny relay, parks a room there, and waits for your browser to walk in.

```text
 your computer                          the browser
┌──────────────────────┐              ┌──────────────────────┐
│  ~/Notes      ───────┼── WebRTC ────┼─► /riozeos/drives/   │
│  AnkiConnect  ───────┼── encrypted ─┼─► notes              │
│  Ollama       ───────┼── DataChannel┼─► Anki panel         │
│  API key (0600)      │      ▲       │   AI panel           │
└──────────────────────┘      │       └──────────────────────┘
                              │                    riozeOS app
                    a relay meets the two once
                    (four words, then never again)
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
RIozeLink 0.2.0 · listening
relay    wss://relay.rioze.dev
words    amber-cobalt-summit-drift (14m 03s left)
clients  no clients yet
shares   none yet
config   ~/.config/riozelink/config.json
```

**2. Share a folder.** Either from the panel's other terminal or from the riozeOS app later.

```sh
riozelink folders add ~/Notes --label Notes
```

**3. Connect riozeOS.** Open riozeOS and start the **RiozeLink** app. Type the four words and
press Connect. That is the entire setup. No address, no port, no code to copy carefully.

What happens under the hood, in order:

1. The words name a room: both the daemon and the browser hash them, and both dial out to the relay
   to meet in that room. The relay never learns the words themselves.
2. The browser generates an ECDSA P-256 key pair and keeps the private half non-extractable in
   IndexedDB. It never leaves the browser.
3. The two sides swap a WebRTC offer and answer through the room. This is only an introduction. The
   conversation itself runs over the DataChannel, encrypted by DTLS, and the relay is done with you.
4. Over that channel the browser sends `auth:hello`. The daemon answers with its own public key, a
   nonce, and a signature over the browser's nonce. The client verifies it, so it knows it found
   your daemon and not something else in the room.
5. For the first pairing the browser must also prove it knows the words: it stretches them with
   PBKDF2 into a key and sends an HMAC of the daemon's nonce. The phrase itself never crosses the
   wire. The same message carries a signature from the browser's key, so the key being stored is
   the key being used.
6. The daemon checks both, writes the browser's fingerprint into `authorizedClients`, and retires
   the words on the spot. A fresh phrase appears for the next device.

**4. Use it.** The shared folder appears in the riozeOS File Explorer under `/riozeos/drives/remote-notes`.
Every read and write you make there lands on the folder you picked.

## Everyday use

### Reconnecting

Open the app in riozeOS and press Connect. There is nothing to type. The browser and the daemon
meet in a room named after both their fingerprints, a name only those two can compute, and the
browser proves itself with the key it stored during pairing. The daemon's identity survives
restarts, the browser remembers its fingerprint from the first pairing, and a different machine in
that room is refused.

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
  token.
- **OpenAI-compatible.** Any endpoint that speaks `/v1/chat/completions` with `stream: true`
  works, including self-hosted gateways. The key is sent once over the encrypted channel, written
  to `config.json` with `0600` permissions, and only ever read back in masked form.

Setting a key is a write-only affair: the app opens a dialog, sends the key, and shows
`sk-...1234` from there on. To replace one, use **Set a new key**. To remove one, use **Clear**.

## The configuration file

`~/.config/riozelink/config.json`, created on first start. It is meant to be edited by hand, and
anything unreadable falls back to its default rather than breaking the daemon.

```json
{
	"version": 1,
	"hostName": "rioze-macbook",
	"relay": "wss://relay.rioze.dev",
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

| Command                                          | What it does                                              |
| ------------------------------------------------ | --------------------------------------------------------- |
| `riozelink`                                      | Starts the daemon and the terminal panel.                 |
| `riozelink --relay wss://…`                      | Meets the browser somewhere other than the default relay. |
| `riozelink --stun stun:stun.l.google.com:19302`  | Adds STUN servers, for links behind stubborn NATs.        |
| `riozelink --quiet`                              | Prints the words once, then only log lines.               |
| `riozelink relay`                                | Runs a relay of your own, for a network you control.       |
| `riozelink folders list`                         | Shows the shared folders.                                 |
| `riozelink folders add <path> [--label Notes]`   | Shares a folder.                                          |
| `riozelink folders remove <id>`                  | Stops sharing one.                                        |
| `riozelink clients list`                         | Shows the browsers this daemon remembers.                 |
| `riozelink clients revoke <name>`                | Forgets one, room and all.                                |
| `riozelink status`                               | A summary of the config file, clients included.           |

On the panel, `n` rolls a fresh phrase, `h` shows the first-connection notes, and `q` stops
the daemon.

## The relay

Two ends have to be introduced to each other before WebRTC can take over, and neither can be asked
for an address. The meeting point is a relay: a public Worker in `relay/` that holds a room with
two WebSockets in it and forwards SDP and ICE between them. It cannot read a file, a phrase, or a
message, and a room disappears the moment it empties.

- The default is `wss://relay.rioze.dev`, the copy this project runs.
- You can deploy your own in about two minutes, free, by following `relay/README.md`. Point both
  ends at it with `--relay` and the app's *Meeting point* field.
- On a network you already control, `riozelink relay` runs the same protocol from this repository,
  no Cloudflare required.

After a pairing, the relay is already out of the picture: the two peers keep talking directly, and
the only reason the daemon stays parked in a room is so a returning browser can find it.

## How it works

### The pieces

| Piece                    | Where it lives            | What it does                                                                 |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------------- |
| The words                | `src/words.ts`            | 534 plain words, four per phrase, no lookalike characters. About 36 bits each. |
| Relay link               | `src/relay.ts`            | One socket per room, reconnecting on its own, forwarding introductions.      |
| Relay server             | `src/relay-server.ts`     | The same protocol as a Bun process, for `riozelink relay` and for the tests. |
| Relay worker             | `relay/`                  | The public copy, a Durable Object per room on Cloudflare.                     |
| WebRTC link              | `src/peer.ts`             | Answers the browser's offer, trickles candidates, hands over the DataChannel. |
| Auth                     | `src/session.ts`          | Hello, proof, pairing. Every other message waits behind it.                   |
| Filesystem               | `src/vfs.ts`, `src/sandbox.ts` | Path fence, chunked reads and writes, part files, change watching.       |
| Anki                     | `src/anki.ts`             | One toggle, a five-second probe, and a POST to the loopback.                  |
| AI                       | `src/ai.ts`               | Two dialects, one streaming shape, keys stay here.                            |
| Wire contract            | `src/protocol.ts`         | The one file both sides build their clients and their dispatchers from. Rooms and the pairing proof are derived here too. |

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

Returning needs no words because the room itself is the proof of who belongs in it: both ends hash
their two public fingerprints together, and only those two can arrive at that name. The daemon parks
one such room per paired browser and nothing else, so a client it has never met has nowhere to knock.

### The four words

A phrase is four words from a list of 534, about 36 bits. That is far too much for a stranger to
walk through: ten wrong attempts replace the phrase, the phrase itself dies after fifteen minutes,
and the relay refuses to let a room be hammered while somebody tries. It is also short enough to
read off a terminal and type on a phone.

The phrase does three jobs at once. It is what a person reads, it names the room (hashed, so the
relay never sees it), and it is the secret that proves the person was at that terminal. The proof is
an HMAC through a PBKDF2-stretched key, so the phrase itself never crosses the wire in either
direction.

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
machine-in-the-middle does not get in. A pairing also has to prove the four words, which is what
stops someone who wandered into the right room.

What the daemon will never do, no matter who asks:

- Touch a path outside the folders you shared.
- Run a shell command, open a port, or scan your network.
- Return an API key in any form other than a mask.
- Write its own files anywhere but the config directory.

What is worth knowing:

- An authorized client can add new folders to share and turn Anki on. That is the feature, but it
  is also reach. Revoke a client with `riozelink clients revoke <name>` and restart the daemon.
- The four words are a secret while they last. Pair from a terminal you are looking at, and do not
  read them out to anyone you would not hand a key to.
- The relay sees that two connections met in some room. It does not see the words, the files, the
  chats, or the keys.
- The config file holds your API key in plain text. It is written with permissions for your user
  only, which protects it from other accounts, not from you.

## Troubleshooting

**"Pairing failed. Check the four words on the host and try again."** A phrase expires after fifteen
minutes and retires the moment another device uses it. Look at the panel for the current one.

**Nothing happens when the words are typed.** The two ends meet on a relay. If the daemon cannot
reach `wss://relay.rioze.dev`, check its log for a reconnect line; if you set your own relay, make
sure both ends were told the same URL. The panel says which relay it is parked on.

**Anki says it is not reachable.** AnkiConnect has to be installed in Anki and Anki itself has to
be open. The default port is 8765 and can be changed in both AnkiConnect's settings and
`config.json`. The daemon probes every five seconds while the toggle is on, so opening Anki lights
the indicator up on its own.

**The AI endpoint says nothing is listening.** For Ollama, `ollama serve` has to be running and the
model in `config.json` has to be pulled already. The gateway also has its own toggle, off by
default.

**A file operation answers `permission` or `denied`.** The path left the shared folder, possibly
through a symlink, or the host itself does not have the permission. Both are the fence working.

**`riozelink relay` says the port is in use.** Something already listens on 4400. Pass
`--port 5000`, or stop the other relay.

## Development

```sh
bun run start   # run the daemon
bun test        # the end to end suite
bun run check   # types
```

The tests are the reference client. They start a real relay and a real daemon on free ports with a
temporary config directory, connect real WebRTC peers, pair with the actual words, and then exercise
the rooms, filesystem, path refusals, symlink escapes, Anki forwarding against a local fake, and AI
streaming against a fake Ollama that answers one word per chunk. If the daemon satisfies that suite,
it satisfies the browser, because both only ever meet at `src/protocol.ts`.
