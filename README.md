# RiozeLink

**Your computer's files and services, reachable from [riozeOS](https://rioze.dev) in the browser.**

English · [日本語](README.ja.md)

RiozeLink is a small daemon you run on your own computer. It opens one private, encrypted link to
riozeOS in the browser, and over that link RiozeOS can browse folders you chose to share, talk to
AnkiConnect, and send AI chats through Ollama or an OpenAI-compatible endpoint with your own key.
Nothing needs a server on the internet. Nothing needs an account.

```text
 your computer                          the browser
┌──────────────────────┐              ┌──────────────────────┐
│  ~/Notes      ───────┼── WebRTC ────┼─► /riozeos/drives/   │
│  AnkiConnect  ───────┼── encrypted ─┼─► notes              │
│  Ollama       ───────┼── DataChannel┼─► Anki panel         │
│  API key (0600)      │              │   AI panel           │
└──────────────────────┘              └──────────────────────┘
        riozelink                          riozeOS app
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
- A riozeOS instance in a browser that can reach this computer on the local network.
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
RIozeLink 0.1.0 · listening
address  ws://192.168.1.20:4287
code     K7F2-9QXW (14m 03s left)
clients  no clients yet
shares   none yet
config   ~/.config/riozelink/config.json
```

**2. Share a folder.** Either from the panel's other terminal or from the riozeOS app later.

```sh
riozelink folders add ~/Notes --label Notes
```

**3. Connect riozeOS.** Open riozeOS and start the **RiozeLink** app. Paste the address, then the
code, and press Connect. If the address belongs to the machine the browser runs on, `ws://localhost`
works as well.

What happens under the hood, in order:

1. The browser generates an ECDSA P-256 key pair and keeps the private half non-extractable in
   IndexedDB. It never leaves the browser.
2. The browser joins the room the code names and the two sides swap a WebRTC offer and answer over
   the signaling WebSocket. This is only an introduction. The conversation itself runs over the
   DataChannel, encrypted by DTLS.
3. Over that channel the browser sends `auth:hello`. The daemon answers with its own public key, a
   nonce, and a signature over the browser's nonce. The client verifies it, so it knows it found
   your daemon and not something else on the network.
4. The browser signs the daemon's nonce with its own key and sends `auth:pair` with the code. The
   daemon checks both and writes the client's fingerprint into `authorizedClients`.
5. The code retires itself right there. The next connection uses the stored key instead, so you
   never type a code again on that browser.

**4. Use it.** The shared folder appears in the riozeOS File Explorer under `/riozeos/drives/notes`.
Every read and write you make there lands on the folder you picked.

## Everyday use

### Reconnecting

Open the app in riozeOS and press Connect. A known browser skips the code entirely and proves itself
with a signature. The address is remembered per browser, so in practice this is one press.

If the daemon restarts it keeps its identity. The browser remembers the host's fingerprint from the
first pairing and checks it again on every connect. If a different machine answers on the same
address, the app refuses to continue.

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

Turn the integration on in the app's **Anki** tab or in the config file. The daemon then probes
`127.0.0.1:8765` and reports whether Anki desktop is actually open. While it is on, every
AnkiConnect action the app asks for is forwarded verbatim. While it is off, the daemon refuses with
`denied`, even for a paired client.

Nothing about your collection is stored anywhere. The calls are proxied and forgotten.

### AI

The **AI** tab has two providers.

- **Ollama.** The endpoint defaults to `http://127.0.0.1:11434`. No key. Chats stream back token by
  token.
- **OpenAI-compatible.** Any endpoint that speaks `/v1/chat/completions` with `stream: true`
  works, including self-hosted gateways. The key is sent once over the encrypted channel, written
  to `config.json` with `0600` permissions, and only ever read back in masked form.

## The configuration file

`~/.config/riozelink/config.json`, created on first start. It is meant to be edited by hand, and
anything unreadable falls back to its default rather than breaking the daemon.

```json
{
	"version": 1,
	"hostName": "rioze-macbook",
	"port": 4287,
	"folders": {
		"notes": { "label": "Notes", "path": "/Users/rioze/Notes" }
	},
	"anki": { "enabled": false, "port": 8765 },
	"ai": {
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

`identity.json` lives next to it and holds the daemon's own key pair. Keep it. Replacing it makes
every browser ask for a pairing code again.

Set `RIOZELINK_CONFIG_DIR` to move both files somewhere else, which is also how the tests keep
their hands off a real home directory.

## Commands

| Command                                          | What it does                                              |
| ------------------------------------------------ | --------------------------------------------------------- |
| `riozelink`                                      | Starts the daemon and the terminal panel.                 |
| `riozelink --port 5000 --bind 0.0.0.0`           | Starts it on another port or interface.                   |
| `riozelink --stun stun:stun.l.google.com:19302`  | Adds STUN servers, for links that leave the local network. |
| `riozelink --quiet`                              | Prints the address and the code once, then only log lines. |
| `riozelink folders list`                         | Shows the shared folders.                                 |
| `riozelink folders add <path> [--label Notes]`   | Shares a folder.                                          |
| `riozelink folders remove <id>`                  | Stops sharing one.                                        |
| `riozelink status`                               | A summary of the config file, clients included.           |

On the panel, `n` replaces the pairing code, `h` shows the first-connection notes, and `q` stops
the daemon.

## How it works

### The pieces

| Piece                    | Where it lives            | What it does                                                                 |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------------- |
| Signaling server         | `src/signaling.ts`        | Checks a room name against the pairing code or the host fingerprint, relays SDP and ICE. |
| WebRTC link              | `src/peer.ts`             | Answers the browser's offer, trickles candidates, hands over the DataChannel. |
| Auth                     | `src/session.ts`          | Hello, proof, pairing. Every other message waits behind it.                   |
| Filesystem               | `src/vfs.ts`, `src/sandbox.ts` | Path fence, chunked reads and writes, part files, change watching.       |
| Anki                     | `src/anki.ts`             | One toggle and a POST to the loopback.                                        |
| AI                       | `src/ai.ts`               | Two dialects, one streaming shape, keys stay here.                            |
| Wire contract            | `src/protocol.ts`         | The one file both sides build their clients and their dispatchers from.       |

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
pins the fingerprint it sees during the first pairing. Every later connection re-checks that
fingerprint against the one it stored, which is why a different machine on the same address cannot
quietly take over. A room named after the daemon's fingerprint exists for exactly this return path.

The pairing code is a one-time secret with a short life. It lasts fifteen minutes, dies the moment
a client pairs with it, and ten wrong attempts replace it. After that it is useless to everyone,
including a client that saw it over someone's shoulder.

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
so the signaling server only ever carries introductions. Every session has to pass the auth
exchange before any other message is answered, and both sides sign a nonce the other side chose, so
a replay or a machine-in-the-middle does not get in.

What the daemon will never do, no matter who asks:

- Touch a path outside the folders you shared.
- Run a shell command, open a port, or scan your network.
- Return an API key in any form other than a mask.
- Write its own files anywhere but the config directory.

What is worth knowing:

- An authorized client can add new folders to share and turn Anki on. That is the feature, but it
  is also reach. Revoke a client by deleting its fingerprint from `authorizedClients` and
  restarting the daemon.
- The pairing code travels through your terminal and the local network. Pair on a network you trust,
  and pair once. After that the code does not matter.
- The config file holds your API key in plain text. It is written with permissions for your user
  only, which protects it from other accounts, not from you.

## Troubleshooting

**"That room is not open."** The code expired, was already used, or the address points at something
else. Check the panel for the current code. Codes are replaced every fifteen minutes.

**The app cannot reach the address at all.** The daemon binds `0.0.0.0`, so a firewall is the
usual suspect. Allow the port, or use the address the panel prints rather than `localhost` when the
browser runs on a different machine.

**Anki says it is not reachable.** AnkiConnect has to be installed in Anki and Anki itself has to
be open. The default port is 8765 and can be changed in both AnkiConnect's settings and
`config.json`.

**The AI endpoint says nothing is listening.** For Ollama, `ollama serve` has to be running and the
model in `config.json` has to be pulled already.

**A file operation answers `permission` or `denied`.** The path left the shared folder, possibly
through a symlink, or the host itself does not have the permission. Both are the fence working.

**`bun run start` says the port is in use.** Something already listens on 4287. Pass
`--port 5000`, or stop the other daemon.

## Development

```sh
bun run start   # run the daemon
bun test        # the end to end suite
bun run check   # types
```

The tests are the reference client. They start a real daemon on a free port with a temporary config
directory, connect real WebRTC peers, pair, and then exercise the filesystem, path refusals,
symlink escapes, Anki forwarding against a local fake, and AI streaming against a fake Ollama that
answers one word per chunk. If the daemon satisfies that suite, it satisfies the browser, because
both only ever meet at `src/protocol.ts`.
