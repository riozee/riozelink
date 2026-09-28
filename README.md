# RiozeLink

**Your computer's files and services, reachable from [riozeOS](https://rioze.dev) in the browser.**

English · [日本語](README.ja.md)

RiozeLink is a small daemon you run on your own computer. It opens one private, encrypted link to
riozeOS in the browser, and over that link RiozeOS can browse folders you chose to share, talk to
AnkiConnect, and send AI chats through Ollama or an OpenAI-compatible endpoint with your own key.
Nothing needs an account, and nothing needs a port to be open on your router. The daemon registers a
name with a signaling server, the same way the `peerjs` library does, and waits for your browser to
walk in.

```text
 your computer                          the browser
┌──────────────────────┐              ┌──────────────────────┐
│  ~/Notes      ───────┼── WebRTC ────┼─► /riozeos/drives/   │
│  AnkiConnect  ───────┼── encrypted ─┼─► notes              │
│  Ollama       ───────┼── DataChannel┼─► Anki panel         │
│  API key (0600)      │      ▲       │   AI panel           │
└──────────────────────┘      │       └──────────────────────┘
                              │                    riozeOS app
                 a signaling server introduces the two once
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
RIozeLink 0.3.0 · listening
signal   wss://0.peerjs.com/peerjs
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

1. The words name a meeting point. Both the daemon and the browser hash them into the same peer id
   and register with the signaling server under it. The server never learns the words themselves.
2. The browser generates an ECDSA P-256 key pair and keeps the private half non-extractable in
   IndexedDB. It never leaves the browser.
3. The two sides swap a WebRTC offer and answer through the server. This is only an introduction.
   The conversation itself runs over the DataChannel, encrypted by DTLS, and the server is done
   with you.
4. Over that channel the browser sends `auth:hello`. The daemon answers with its own public key, a
   nonce, and a signature over the browser's nonce. The client verifies it, so it knows it found
   your daemon and not something else that answered on the way.
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
register under a name made of both their fingerprints, a name only those two can compute, and the
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
  token.
- **OpenAI-compatible.** Any endpoint that speaks `/v1/chat/completions` with `stream: true`
  works, including self-hosted gateways. The key is sent once over the encrypted channel, written
  to `config.json` with `0600` permissions, and only ever read back in masked form.

Setting a key is a write-only affair: the app opens a dialog, sends the key, and shows
`sk-...1234` from there on. To replace one, use **Set a new key**. To remove one, use **Clear**.

### Reading the web

The Browser in riozeOS can ask the daemon for a page. Most of the web refuses to sit in a frame
(`X-Frame-Options`, a `frame-ancestors` policy), and the daemon can fetch the page with this
machine's network and hand back a document that can be shown: one document per request, the
meta tags that caused the refusal dropped, a `<base>` tag so the page's relative URLs still
resolve, and a small script that reports link clicks back to the app so following a link keeps
going through the same route.

The document comes back in 45 KiB chunks over the data channel, the way a file does, and only
the document — images, stylesheets and scripts keep their real addresses and load straight from
their own origins. Nothing is written to disk and nothing is cached between sessions; four pages
are held per session while the tab is open.

There is also a cheaper call, `web:probe`, that reads a page's *headers* and says whether it
carries framing rules. The Browser uses it to tell a page that loaded quickly apart from a page
that was refused, since a refused frame and an empty one look identical from inside the browser.

The fetch has no cookie jar. It sends no credentials the site does not hand out publicly, and
only `http` and `https` URLs are accepted. A page fetched this way cannot sign anyone in, and the
app says so on screen instead of implying otherwise.

## The configuration file

`~/.config/riozelink/config.json`, created on first start. It is meant to be edited by hand, and
anything unreadable falls back to its default rather than breaking the daemon.

```json
{
	"version": 1,
	"hostName": "rioze-macbook",
	"signal": "wss://0.peerjs.com/peerjs",
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

| Command                                         | What it does                                               |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `riozelink`                                     | Starts the daemon and the terminal panel.                  |
| `riozelink --signal ws://host:9000`             | Meets the browser somewhere other than the default server. |
| `riozelink --stun stun:stun.l.google.com:19302` | Adds STUN servers, for links behind stubborn NATs.         |
| `riozelink --quiet`                             | Prints the words once, then only log lines.                |
| `riozelink folders list`                        | Shows the shared folders.                                  |
| `riozelink folders add <path> [--label Notes]`  | Shares a folder.                                           |
| `riozelink folders remove <id>`                 | Stops sharing one.                                         |
| `riozelink clients list`                        | Shows the browsers this daemon remembers.                  |
| `riozelink clients revoke <name>`               | Forgets one, name and all.                                 |
| `riozelink status`                              | A summary of the config file, clients included.            |

On the panel, `n` rolls a fresh phrase, `h` shows the first-connection notes, and `q` stops
the daemon.

## The meeting point

Two ends have to be introduced before WebRTC can take over, and neither can be asked for an address.
So the daemon registers a name with a signaling server and waits there. A browser holding the four
words hashes them into the same name, registers itself, and offers to it. The server forwards the
offer, the answer and the ICE candidates, and once the two are talking directly it is out of the
picture. Reconnecting later needs no words at all, because the name both sides compute from their
fingerprints is one nobody else can guess.

The default is `wss://0.peerjs.com/peerjs`, the public PeerServer cloud that the `peerjs` library
uses itself. There is nothing to sign up for, and it only ever carries introductions. Running your
own takes one command and no code. Run `npx peerjs --port 9000` on a machine both ends can reach,
then start the daemon with `riozelink --signal ws://your-host:9000` and type the same address into
the app's _Meeting point_ field. The panel and the Overview tab both name the server in use, so the
two ends can be checked against each other at a glance.

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
| The words     | `src/words.ts`                 | 534 plain words, four per phrase, no lookalike characters. About 36 bits each.                                               |
| Signaling     | `src/signal.ts`                | One registration per peer id, heartbeats, reconnects with backoff.                                                           |
| WebRTC link   | `src/peer.ts`                  | Answers the browser's offer, trickles candidates, hands over the DataChannel.                                                |
| Auth          | `src/session.ts`               | Hello, proof, pairing. Every other message waits behind it.                                                                  |
| Filesystem    | `src/vfs.ts`, `src/sandbox.ts` | Path fence, chunked reads and writes, part files, change watching.                                                           |
| Anki          | `src/anki.ts`                  | One toggle, a five-second probe, and a POST to the loopback.                                                                 |
| AI            | `src/ai.ts`                    | Two dialects, one streaming shape, keys stay here.                                                                           |
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

Returning needs no words because the name both ends register under is proof enough of who belongs
there. They hash their two public fingerprints together, and only those two can arrive at that
name. The daemon holds one such registration per paired browser and nothing else, so a client it has
never met has nowhere to knock.

### The four words

A phrase is four words from a list of 534, about 36 bits. That is far too much for a stranger to
walk through. Ten wrong attempts invite a fresh phrase, the phrase itself dies after fifteen
minutes, and it retires the moment it is used. It is also short enough to read off a terminal and
type on a phone.

The phrase does three jobs at once. It is what a person reads, it names the meeting point once it
is hashed, and it is the secret that proves the person was at that terminal. The proof is an HMAC
through a PBKDF2-stretched key, so the phrase itself never crosses the wire in either direction.

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
so the signaling server only ever carries introductions. Every session has to pass the auth exchange
before any other message is answered, and both sides sign a nonce the other side chose, so a replay
or a machine-in-the-middle does not get in. A pairing also has to prove the four words, which is what
stops someone who wandered into the right meeting point.

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
- The signaling server sees that two connections met under some name. It does not see the words,
  the files, the chats, or the keys. It is somebody else's machine by default, so treat it as one
  more party that can watch introductions and run your own when you would rather it did not.
- The config file holds your API key in plain text. It is written with permissions for your user
  only, which protects it from other accounts, not from you.

## Troubleshooting

**"Pairing failed. Check the four words on the host and try again."** A phrase expires after fifteen
minutes and retires the moment another device uses it. Look at the panel for the current one.

**Nothing happens when the words are typed.** The two ends meet on a signaling server. If the daemon
cannot reach `wss://0.peerjs.com/peerjs`, check its log for a retry line. If you run your own, make
sure both ends were told the same address. The panel and the app's Overview tab both say which
server is in use.

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
default.

**A file operation answers `permission` or `denied`.** The path left the shared folder, possibly
through a symlink, or the host itself does not have the permission. Both are the fence working.

**The daemon says another copy of itself is already registered.** Two daemons share one identity when
they use the same config directory. Stop the other one, or point this one somewhere else with
`RIOZELINK_CONFIG_DIR`.

## Development

```sh
bun run start   # run the daemon
bun test        # the end to end suite
bun run check   # types
```

The tests are the reference client. They start a real PeerServer and a real daemon on free ports
with a temporary config directory, connect real WebRTC peers, pair with the actual words, and then
exercise the registrations, filesystem, path refusals, symlink escapes, Anki forwarding against a
local fake, and AI streaming against a fake Ollama that answers one word per chunk. If the daemon
satisfies that suite, it satisfies the browser, because both only ever meet at `src/protocol.ts`.
