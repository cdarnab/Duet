/* Runs in the page's own JavaScript context on Netflix only.
 *
 * Netflix ignores direct video.play/pause/currentTime writes. Its player API
 * does not. This bridge seeks, plays, and pauses. No page data is read or sent.
 */
(function () {
  if (window.__duetMain) return;
  window.__duetMain = true;

  function player() {
    try {
      const api = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const id = api.getAllPlayerSessionIds()[0];
      return api.getVideoPlayerBySessionId(id);
    } catch {
      return null;
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.source !== 'duet') return;

    const p = player();
    if (!p) return;

    if (msg.cmd === 'seek') p.seek(Math.max(0, msg.value) * 1000);
    else if (msg.cmd === 'play') p.play();
    else if (msg.cmd === 'pause') p.pause();
  });

  const announce = () => window.postMessage({ source: 'duet-main', ready: true, api: 'netflix' }, '*');
  announce();
  // The player mounts late; keep announcing until the content script hears us.
  const t = setInterval(() => (player() ? (announce(), clearInterval(t)) : null), 1000);
  setTimeout(() => clearInterval(t), 60000);
})();
