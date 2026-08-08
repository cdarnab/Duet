/* global DuetSync */
/* Duet content script.
 *
 * Attaches to whatever <video> a page happens to be playing and keeps it
 * aligned with the room. Site-agnostic by design: we drive the standard
 * media element, so anything that uses one works without a per-site adapter.
 * Netflix gets a narrow exception for seeking (see main-world.js).
 */
(function () {
  if (window.__duetAttached) return;
  window.__duetAttached = true;

  const CHECK_MS = 250;
  const TICK_MS = 900;

  let video = null;
  let port = null;
  let offset = 0;
  let selfId = '';
  let state = { paused: true, position: 0, rate: 1, atServerTime: Date.now(), seq: -1 };
  let connectedRoom = '';
  let suppressUntil = 0; // ignore our own player events while correcting
  let netflixBridge = false;
  let banner = null;

  let transportGen = 0;

  const serverNow = () => Date.now() + offset;
  const suppressed = () => Date.now() < suppressUntil;
  const hold = (ms = 1200) => (suppressUntil = Date.now() + ms);

  /* --------------------------------------------------------- find a video */

  function pickVideo() {
    const candidates = [...document.querySelectorAll('video')].filter(
      (v) => (v.readyState > 0 || v.currentSrc || v.src) && v.clientWidth * v.clientHeight >= 40000
    );
    if (!candidates.length) return null;
    // The one the person is actually watching: playing beats paused, big beats small.
    candidates.sort((a, b) => {
      const play = Number(!b.paused) - Number(!a.paused);
      if (play) return play;
      return b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight;
    });
    return candidates[0];
  }

  function attach(v) {
    if (v === video) return;
    video = v;
    ['play', 'pause', 'seeked', 'ratechange'].forEach((ev) =>
      video.addEventListener(ev, onLocalEvent)
    );
    showBanner('Duet is watching this player');
    applyRoomState();
  }

  const observer = new MutationObserver(() => {
    const v = pickVideo();
    if (v) attach(v);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => {
    const v = pickVideo();
    if (v) attach(v);
  }, 1000);

  /* ------------------------------------------------------- seek via bridge */

  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data && ev.data.source === 'duet-main' && ev.data.ready) {
      netflixBridge = true;
    }
  });

  function forceResync() {
    if (!video) {
      showBanner('Duet could not find a video on this page');
      return;
    }
    seekTo(DuetSync.projected(state, serverNow()));
    setPaused(state.paused);
    showBanner('Resynced to the room');
  }

  function seekTo(seconds) {
    hold();
    if (netflixBridge) {
      window.postMessage({ source: 'duet', cmd: 'seek', value: seconds }, '*');
      return;
    }
    try {
      video.currentTime = seconds;
    } catch {
      /* some players clamp or refuse; the next correction pass retries */
    }
  }

  function clickTransport(paused) {
    const selectors = ['.ytp-play-button', 'button[data-uia="player-play-pause-button"]', '.playPause'];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (!btn) continue;
      const label = (btn.getAttribute('aria-label') || btn.title || '').toLowerCase();
      const isPause = label.includes('pause');
      const isPlay = label.includes('play') && !isPause;
      if (paused && isPause) {
        btn.click();
        return true;
      }
      if (!paused && isPlay) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function setPaused(paused) {
    if (!video) return;
    hold(1500);
    const gen = ++transportGen;
    if (netflixBridge) {
      window.postMessage({ source: 'duet', cmd: paused ? 'pause' : 'play' }, '*');
      return;
    }
    if (paused) {
      if (!video.paused) video.pause();
    } else if (video.paused) {
      const attempt = video.play();
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(() => {
          if (!clickTransport(false)) {
            showBanner('Click the video once — the browser blocked autoplay');
          }
        });
      }
    }
    setTimeout(() => {
      if (gen !== transportGen || !video || !connectedRoom || suppressed()) return;
      if (Boolean(video.paused) !== Boolean(paused)) clickTransport(paused);
    }, 280);
  }

  function applyRoomState() {
    if (!video || !connectedRoom || state.seq < 0 || suppressed()) return;
    setPaused(state.paused);
    const target = DuetSync.projected(state, serverNow());
    if (Math.abs(video.currentTime - target) > DuetSync.constants.HARD_SEEK) seekTo(target);
  }

  /* ------------------------------------------------------ local -> server */

  function onLocalEvent(ev) {
    if (!video) return;
    if (ev.type === 'ratechange' && Math.abs(video.playbackRate - 1) < 0.1) return;
    // User play/pause must win immediately. Otherwise the correction loop still
    // has the old room state and unpauses (or pauses) the click we just made.
    if (ev.type === 'play' || ev.type === 'pause') {
      hold(1500);
      state = {
        ...state,
        paused: video.paused,
        position: video.currentTime,
        atServerTime: serverNow(),
        seq: Math.max(state.seq, 0),
      };
      push();
      return;
    }
    if (suppressed()) return;
    push();
  }

  function push() {
    if (!video || !port) return;
    port.postMessage({
      type: 'state',
      paused: video.paused,
      position: video.currentTime,
      rate: 1,
      title: document.title,
    });
  }

  /* ------------------------------------------------------ server -> local */

  function correct() {
    if (!video || !connectedRoom || state.seq < 0 || suppressed()) return;

    const c = DuetSync.correction({
      state,
      serverNow: serverNow(),
      localPosition: video.currentTime,
      duration: video.duration,
    });

    if (c.action === 'seek') seekTo(c.target);
    else if (c.action === 'rate' && Math.abs(video.playbackRate - c.rate) > 0.005) {
      hold(300);
      video.playbackRate = c.rate;
    }

    if (Boolean(video.paused) !== Boolean(state.paused)) setPaused(state.paused);
  }
  setInterval(correct, CHECK_MS);

  setInterval(() => {
    if (!video || !port) return;
    port.postMessage({ type: 'tick', position: video.currentTime, paused: video.paused, title: document.title });
  }, TICK_MS);

  /* ---------------------------------------------------------------- port */

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.state) state = msg.state;
    if (msg.type === 'resync' || (msg.type === 'state' && msg.resync)) forceResync();
  });

  function openPort() {
    port = chrome.runtime.connect({ name: 'duet' });
    port.onMessage.addListener((msg) => {
      if (msg.offset !== undefined) offset = msg.offset;
      switch (msg.type) {
        case 'clock':
          offset = msg.offset;
          break;
        case 'status':
          connectedRoom = msg.room || '';
          if (msg.selfId) selfId = msg.selfId;
          break;
        case 'welcome':
          if (msg.selfId) selfId = msg.selfId;
          if (msg.room) connectedRoom = msg.room;
          if (msg.state) state = msg.state;
          applyRoomState();
          break;
        case 'state':
          state = msg.state;
          if (msg.resync) forceResync();
          else if (!msg.self && msg.state?.updatedBy !== selfId) applyRoomState();
          break;
        case 'cue':
          runCountdown(msg.startAt);
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(openPort, 1000);
    });
  }
  openPort();

  /* ------------------------------------------------------------ overlay */

  function ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'left:50%', 'top:24px',
      'transform:translateX(-50%)', 'padding:10px 18px', 'border-radius:10px',
      'background:rgba(10,14,26,.94)', 'color:#e8e6f0', 'border:1px solid #232c4a',
      'font:500 14px/1.3 ui-sans-serif,system-ui,sans-serif', 'pointer-events:none',
      'opacity:0', 'transition:opacity .2s ease',
    ].join(';');
    document.documentElement.appendChild(banner);
    return banner;
  }

  function showBanner(text, ms = 2400) {
    const el = ensureBanner();
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => (el.style.opacity = '0'), ms);
  }

  function runCountdown(startAt) {
    const el = ensureBanner();
    el.style.opacity = '1';
    const step = () => {
      const left = startAt - serverNow();
      if (left <= 0) {
        el.textContent = 'Now';
        setTimeout(() => (el.style.opacity = '0'), 800);
        return;
      }
      el.textContent = `Starting in ${Math.ceil(left / 1000)}`;
      requestAnimationFrame(step);
    };
    step();
  }
})();
