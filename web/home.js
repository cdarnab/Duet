(() => {
  'use strict';
  const codeInput = document.getElementById('code');
  const drawer = document.getElementById('hero-join');
  const joinStatus = document.getElementById('join-status');
  const createStatus = document.getElementById('create-status');
  const clean = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const t = (key) => window.DuetI18n?.t(key) || key;
  let session = { authEnabled: false, authenticated: false, user: null };

  function status(node, text, state = '') { node.textContent = text; node.dataset.state = state; }
  const loginFor = (target) => `/login?next=${encodeURIComponent(target)}`;
  function openJoin() { drawer.hidden = false; drawer.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); setTimeout(() => codeInput.focus(), 120); }
  function roomCode() { const code = clean(codeInput.value); codeInput.value = code; if (code.length >= 4) { status(joinStatus, ''); return code; } status(joinStatus, t('invalidCode'), 'error'); codeInput.focus(); return null; }
  function join(surface) { const code = roomCode(); if (!code) return; const target = `/${surface}.html#${code}`; location.href = session.authEnabled && !session.authenticated ? loginFor(target) : target; }
  async function createRoom() {
    if (session.authEnabled && !session.authenticated) { location.href = loginFor('/?action=create'); return; }
    const buttons = [document.getElementById('create'), document.getElementById('create-hero')]; buttons.forEach((b) => { b.disabled = true; }); status(createStatus, t('creating'));
    try { const res = await fetch('/api/room/new'); if (res.status === 401) { location.href = loginFor('/?action=create'); return; } if (!res.ok) throw new Error(); const body = await res.json(); location.href = `/r/${body.code}`; }
    catch { status(createStatus, t('createError'), 'error'); buttons.forEach((b) => { b.disabled = false; }); }
  }
  function renderSession() {
    const login = document.querySelector('[data-login-link]'), logout = document.querySelector('[data-logout]'), owner = document.querySelector('[data-owner-link]'), identity = document.querySelector('[data-user-label]');
    if (!session.authEnabled) { login.hidden = logout.hidden = owner.hidden = identity.hidden = true; return; }
    login.hidden = session.authenticated; logout.hidden = !session.authenticated; owner.hidden = !(session.authenticated && session.user?.owner); identity.hidden = !session.authenticated; identity.textContent = session.user?.name || session.user?.email || '';
  }
  async function loadSession() {
    try { const res = await fetch('/api/session'); if (res.ok) session = await res.json(); } catch {}
    renderSession();
    if (session.authenticated) { try { const res = await fetch('/api/me'); if (res.ok) { const me = await res.json(); document.getElementById('profile').hidden = !me.canSetName; } } catch {} }
    const params = new URLSearchParams(location.search); if (params.get('action') === 'create' && (!session.authEnabled || session.authenticated)) { history.replaceState({}, '', '/'); createRoom(); }
  }
  document.querySelectorAll('[data-open-join]').forEach((button) => button.addEventListener('click', openJoin));
  document.getElementById('create').addEventListener('click', createRoom); document.getElementById('create-hero').addEventListener('click', createRoom);
  drawer.addEventListener('submit', (event) => { event.preventDefault(); join('companion'); }); document.getElementById('join-tv').addEventListener('click', () => join('tv'));
  codeInput.addEventListener('input', () => { codeInput.value = clean(codeInput.value); status(joinStatus, ''); });
  codeInput.addEventListener('paste', (event) => { event.preventDefault(); codeInput.value = clean((event.clipboardData || window.clipboardData).getData('text')); });
  document.querySelector('[data-logout]').addEventListener('click', () => fetch('/logout', { method: 'POST' }).finally(() => { location.href = '/login'; }));
  document.getElementById('save-name').addEventListener('click', async () => { const output = document.getElementById('name-status'); const res = await fetch('/api/me', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('display-name').value }) }); const body = await res.json().catch(() => ({})); if (!res.ok) { status(output, body.error === 'name_locked' ? 'Your name is already set.' : 'Use 2–24 letters or numbers.', 'error'); return; } document.getElementById('profile').hidden = true; document.querySelector('[data-user-label]').textContent = body.name; });
  fetch('/version.json').then((r) => r.json()).then((info) => { if (!info?.version || !window.DuetExtensionStatus) return; window.DuetExtensionStatus.refresh(info); document.getElementById('ext-action').addEventListener('click', () => window.DuetExtensionStatus.runInstall(location.origin, info)); }).catch(() => {});
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let ticking = false; const update = () => { document.documentElement.style.setProperty('--hero-scroll', String(Math.min(scrollY, innerHeight))); document.querySelector('[data-header]').classList.toggle('is-scrolled', scrollY > 24); ticking = false; };
    addEventListener('scroll', () => { if (!ticking) { requestAnimationFrame(update); ticking = true; } }, { passive: true }); update();
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => { if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); } }), { threshold: .14 });
    document.querySelectorAll('.story-steps li,.setup-card,.device-card').forEach((node) => { node.classList.add('reveal-ready'); observer.observe(node); });
  }
  loadSession();
})();
