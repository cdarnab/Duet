# Duet

Two people, two places, one movie, same frame.

Duet keeps two video players in step to within about 80 milliseconds. It works on
whatever you're already watching — Netflix, Prime Video, Disney+, Max, YouTube,
Jellyfin, Plex, a file on a hard drive — because it drives the browser's own video
player rather than integrating with any particular service.

Duet never copies, relays, or re-streams video. Only timing crosses the wire. You
each need your own access to whatever you're watching.

---

## Read this before you build expectations

**What syncs automatically:** any video playing in a Chrome-family browser, on any
site, once both of you install the extension. This covers every major streaming
service, because they all use a standard HTML5 video element under the hood.

**What needs a helper: a native app on a smart TV, Roku, Fire TV, or Apple TV.**
Those apps are sealed and DRM-protected — nothing can read their playhead or
mirror their picture. But the *device* underneath them is not sealed. Roku
answers HTTP on port 8060, Android TV takes ADB key events, and Apple TV speaks
MediaRemote. So Duet ships an agent you run on any machine in the same house:
it joins the room as a member, reads where the TV actually is, and presses the
right buttons at the right moments. Automatic, closed-loop, no hands.

Where even that is unavailable, TV mode falls back to a **cue console**: a shared
countdown, a live timecode to match, and instructions like *skip back 4 seconds*.

| Their setup | How it works | Accuracy |
|---|---|---|
| Browser, any streaming site | Extension drives the player | ~80 ms, automatic |
| Laptop → TV over HDMI, or a cast tab | Same; the TV is just a monitor | ~80 ms, automatic |
| Smart TV browser + a direct video URL | TV mode plays and syncs it itself | ~80 ms, automatic |
| Apple TV + agent | pyatv, real absolute seek | under 1 s, automatic |
| Roku or Android TV / Fire TV + agent | Skips plus timed pauses | under 1 s, automatic |
| Anything else on a TV | Cue console: countdown, timecode, nudges | ~1 s, hands-on |

**If you want the least fuss, use the HDMI row.** A cable and the extension beat
every clever alternative. The agent exists for when a cable isn't practical.

---

## Run it

```bash
docker compose up -d
./scripts/smoke.sh http://localhost:8080
```

Or without Docker:

```bash
npm install
npm start
```

Open <http://localhost:8080>, create a room, and note the six-letter code.

### Putting it on the internet

Streaming sites are HTTPS, so the browser will only let the extension open a
`wss://` socket. Beyond localhost you need a certificate. Point a hostname at your
machine and create a `.env` with invite-only auth:

```bash
DUET_DOMAIN=duet.arnabbanik.com
DUET_AUTH=on
DUET_OWNER_EMAIL=you@example.com
DUET_SETUP_TOKEN=$(openssl rand -base64 32)
```

```bash
docker compose --profile tls up -d
```

Caddy provisions the certificate automatically. Then open `/setup`, set the owner
password with `DUET_SETUP_TOKEN`, log in, and use **Invite** to create a one-week
link for each person. They choose a password on that link; only invited emails can
open the site or join rooms.

Local `npm start` without `DUET_AUTH=on` stays open for development.

Any small VPS works — the server holds room state in memory and sends a few dozen
bytes per second per person.

---

## Install the extension

Both people do this, in Chrome, Edge, Brave, or Arc.

If the site is already online, download `/duet-extension.zip` from it (the homepage has a button). Otherwise:

```bash
npm run build:extension
```

1. Go to `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → select `extension/` (or the unzipped download). Do not load a leftover `duet-extension/` folder.
4. Click the Duet icon, enter the room code, **Join room**
5. If the site is invite-only, log in on the website first so the extension can use your session cookie

Then just play something. The extension finds whatever video is on the page. When
one of you plays, pauses, or skips, the other follows.

Firefox and Safari need a manifest tweak; Chrome-family browsers work as-is.

---

## Native TVs: the device agent

Run this on any machine on the same network as the TV — a laptop, a Raspberry
Pi, whatever is already there. It joins the room like any other viewer.

```bash
node agent --scan                                   # find Rokus on the network
node agent --room CODE --device roku      --host 192.168.1.42
node agent --room CODE --device androidtv --host 192.168.1.50
node agent --room CODE --device appletv   --id <ID> --credentials <CREDS>
node agent --room CODE --device mock                # no hardware needed
```

Add `--server https://your-host` if the server isn't on localhost.

**Setup per platform.** Roku needs nothing — ECP is on by default; check
Settings → System → Advanced if it doesn't answer. Android TV and Fire TV need
`adb` installed locally and ADB debugging enabled on the device. Apple TV needs
`pip install pyatv`, then `atvremote scan` and
`atvremote --id <ID> --protocol companion pair` once to get credentials.

### The trick that makes it work

A remote control has no seek. You get transport keys and a skip key that jumps a
fixed 10, 15, or 30 seconds — so every correction is quantised, and any gap
smaller than one skip is unreachable.

Except **waiting is a seek**. Pausing a player for 3.2 seconds moves it back 3.2
seconds relative to everyone else, at whatever precision your clock has. That
gives two continuous instruments where there were none:

- hold the device — moves the TV backwards, up to 25 s
- hold the room — moves the TV forwards, up to 8 s

So the planner doesn't pick the skip count that lands nearest. It picks the one
whose *remainder* falls inside a window a pause can absorb — sometimes stopping
deliberately short, sometimes overshooting past the target so the device can
wait the excess off. Every plan lands exactly on target regardless of skip size;
there's a test that replays plans across a spread of gaps and skip sizes to
prove it.

The second half is that TVs report where they are badly: stale by a few hundred
milliseconds and, on Apple TV, rounded to the whole second. That error is bigger
than the planner's entire deadband, so acting on raw readings means correcting
rounding noise forever — pausing a TV that was never out of step. Every reading
is folded into a smoothed local estimate instead. A genuine seek looks nothing
like rounding noise, so it still re-anchors instantly.

Accuracy lands under a second on all three platforms, and closer on Apple TV
where pyatv exposes a true absolute seek.

---

## Using it

**Both on laptops.** Install the extension on both, join the same room, open the
movie, press play. Done. Skips and pauses propagate.

**One on a TV.** Best: HDMI from the laptop, then treat it as a laptop. Do **not**
screen-cast Netflix — DRM blacks out the picture. Otherwise open `/tv.html#YOURCODE`
in the TV's browser (or on a phone next to the TV) and use the cue console. Arrow
keys on the remote shift the room timecode; OK starts a countdown.

**Roku at your house + partner on a MacBook (Netflix).** Casting will not work.
Use the native Netflix app on the Roku and the extension on the MacBook, same
room, same title.

1. Partner: Chrome + Duet extension, log in, create or join the room, open Netflix.
2. You: on a computer that is on the **same Wi-Fi as the Roku** (a laptop, Pi, etc.):

```bash
cd /path/to/duet
npm install
node agent --discover
node agent --room YOURCODE --device roku --host ROKU_IP \
  --server https://duet.arnabbanik.com \
  --email you@example.com --password 'your-password'
```

3. On the Roku, open Netflix and the same movie/episode. Pause it.
4. Partner clicks **Count us in** in the Duet popup. The agent presses play on the
   Roku at the same beat.

Netflix on Roku does not report a playhead, so Duet can keep play/pause and the
countdown in sync automatically, but it cannot measure drift. If you separate, use
**Resync** / **Count us in** again, or skip on the Roku remote. The agent must keep
running for the whole movie.

If you have no extra computer next to the Roku, skip the agent: open
`https://duet.arnabbanik.com/tv.html#YOURCODE` on your phone and follow the cue
console while Netflix plays on the Roku.

**Voice and chat.** Open `/companion.html#YOURCODE` on your phone. That page carries
peer-to-peer voice, notes, and the drift meter, and stays out of the way of the
movie. Use headphones — speakers will echo into the mic.

If voice fails to connect, you're behind a symmetric NAT and need a TURN server. Add
one to the `iceServers` list in `web/duet-client.js`. Playback sync is unaffected;
it never uses peer-to-peer.

---

## Testing

```bash
npm test                             # 51 tests, no network or hardware needed
./scripts/smoke.sh http://localhost:8080
```

Five layers:

- **`test/sync.test.js`** — correction maths and clock alignment in isolation.
- **`test/convergence.test.js`** — a simulated pair of browsers with 4.3 s and
  −2.1 s clock skew, jittery latency, and decoders running 0.4% fast and 0.3%
  slow. Asserts they settle within 120 ms. This backs the browser accuracy claim.
- **`test/control.test.js`** — the correction planner: that plans land exactly on
  target across a spread of gaps and skip sizes, and that neither side is ever
  held longer than a person would tolerate.
- **`test/estimator.test.js`** — that raw device readings really are worse than
  the deadband, and that smoothing fixes it. The load-bearing assertion: across
  the same run, raw readings trigger a spurious correction more than ten times
  and smoothed readings trigger none.
- **`test/agent.test.js`** — the whole loop against a real server and websocket,
  with a simulated set-top box that reports stale, rounded positions and only
  skips in 10-second steps.
- **`test/integration.test.js`** — state relay, late joiners, countdown
  scheduling, chat history, signalling isolation, roster cleanup, path traversal.

Manual check with one machine: open `/companion.html#CODE` and `/tv.html#CODE` in
two windows, paste any `.mp4` URL into the console's source field, and watch them
track each other.

---

## How it works

The problem isn't sending "play" — it's that both machines disagree about what time
it is. So:

1. **Clock alignment.** Each client runs NTP-style exchanges with the server, keeps
   the low-latency half of the samples, and takes the median offset. This survives
   a congested link that would wreck a naive average.
2. **State is a timestamped intent**, not a command: *paused=false, position=615.25,
   as of server time T*. Anyone joining late, or reconnecting, computes where the
   movie should be right now instead of waiting to be told.
3. **Correction is graded.** Under 40 ms: leave it alone. Under 750 ms: trim
   playback speed by up to 5% and glide back over a few seconds — you won't notice,
   and browsers preserve pitch. Beyond that: seek, because it's a real jump.

That third point is the whole trick. Naive watch-party tools seek constantly and
feel broken; Duet seeks about once per session.

### Files

```
server/index.js        websocket relay + static hosting
server/rooms.js        room and member state
shared/sync.js         the sync math — used by server, extension, and pages
extension/             Chrome MV3: background socket, content script, popup
extension/main-world.js  Netflix-only seek bridge (Netflix ignores currentTime writes)
web/companion.html     drift meter, countdown, voice, chat
web/tv.html            big-screen player and cue console
agent/control.js       correction planner — skips plus timed pauses
agent/estimator.js     smooths stale, rounded device readings
agent/agent.js         the loop: read the TV, mirror transport, correct drift
agent/drivers/         roku (ECP), androidtv (ADB), appletv (pyatv), mock
```

The service worker owns the socket, not the tab, so sync survives Netflix's
in-page navigation.

---

## Known limits

- The agent drives the *device*, not the app. It cannot tell which title is
  loaded, so both of you still have to open the same thing yourselves.
- Skip sizes vary by app. The default is 10 s; calibrate once with `--jump`.
- Devices report position stale by a few hundred milliseconds. If yours reads
  consistently early or late, correct it once with `--offset`.
- Chromecast and Google TV's cast mode aren't supported — Netflix's cast
  receiver doesn't expose the standard media namespace.
- Chrome-family browsers only, without manifest changes.
- Rooms live in memory; a server restart drops them, and rejoining the same code
  makes a fresh one. Add Redis in `server/rooms.js` if you need otherwise.
- No authentication. Anyone with the code can join. Six letters from a 31-character
  alphabet is fine for two people for one evening; it is not a security boundary.
- Voice needs a TURN server on strict networks.
