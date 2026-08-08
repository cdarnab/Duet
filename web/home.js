(() => {
  'use strict';

  const codeInput = document.getElementById('code');
  const joinDrawer = document.getElementById('hero-join');
  const joinStatus = document.getElementById('join-status');
  const createStatus = document.getElementById('create-status');
  const sanitizeRoom = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  let session = { authEnabled: false, authenticated: false, user: null };

  const t = (key) => window.DuetI18n?.t(key) || key;

  function setStatus(node, message, type = '') {
    if (!node) return;
    node.textContent = message;
    node.dataset.state = type;
  }

  function safeNext(target) {
    return `/login?next=${encodeURIComponent(target)}`;
  }

  function openJoin() {
    joinDrawer.hidden = false;
    joinDrawer.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    window.setTimeout(() => codeInput.focus(), 150);
  }

  function validCode() {
    const code = sanitizeRoom(codeInput.value);
    codeInput.value = code;
    if (code.length < 4) {
      setStatus(joinStatus, t('invalidCode'), 'error');
      codeInput.focus();
      return null;
    }
    setStatus(joinStatus, '');
    return code;
  }

  function goToRoom(surface) {
    const code = validCode();
    if (!code) return;
    const target = `/${surface}.html#${code}`;
    location.href = session.authEnabled && !session.authenticated ? safeNext(target) : target;
  }

  async function createRoom() {
    if (session.authEnabled && !session.authenticated) {
      location.href = safeNext('/?action=create');
      return;
    }
    const buttons = [document.getElementById('create'), document.getElementById('create-hero')].filter(Boolean);
    buttons.forEach((button) => { button.disabled = true; });
    setStatus(createStatus, t('creatingRoom'));
    try {
      const res = await fetch('/api/room/new');
      if (res.status === 401) {
        location.href = safeNext('/?action=create');
        return;
      }
      if (!res.ok) throw new Error('create_failed');
      const { code } = await res.json();
      location.href = `/r/${code}`;
    } catch {
      setStatus(createStatus, t('roomError'), 'error');
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function renderSession() {
    const login = document.querySelector('[data-login-link]');
    const logout = document.querySelector('[data-logout]');
    const owner = document.querySelector('[data-owner-link]');
    const identity = document.querySelector('[data-user-label]');

    if (!session.authEnabled) {
      login.hidden = true;
      logout.hidden = true;
      owner.hidden = true;
      identity.hidden = true;
      return;
    }

    login.hidden = session.authenticated;
    logout.hidden = !session.authenticated;
    owner.hidden = !(session.authenticated && session.user?.owner);
    identity.hidden = !session.authenticated;
    identity.textContent = session.user?.name || session.user?.email || '';
  }

  async function loadSession() {
    try {
      const res = await fetch('/api/session');
      if (res.ok) session = await res.json();
    } catch {
      // Local development can still use Duet when authentication is disabled.
    }
    renderSession();

    if (session.authenticated) {
      try {
        const res = await fetch('/api/me');
        if (res.ok) {
          const me = await res.json();
          const profile = document.getElementById('profile');
          profile.hidden = !me.canSetName;
        }
      } catch {
        // Profile setup is optional and should never block room controls.
      }
    }

    const params = new URLSearchParams(location.search);
    if (params.get('action') === 'create' && (!session.authEnabled || session.authenticated)) {
      history.replaceState({}, '', '/');
      createRoom();
    }
  }

  document.querySelectorAll('[data-open-join]').forEach((button) => button.addEventListener('click', openJoin));
  document.getElementById('create').addEventListener('click', createRoom);
  document.getElementById('create-hero').addEventListener('click', createRoom);
  document.getElementById('join-tv').addEventListener('click', () => goToRoom('tv'));
  joinDrawer.addEventListener('submit', (event) => {
    event.preventDefault();
    goToRoom('companion');
  });

  codeInput.addEventListener('input', () => {
    codeInput.value = sanitizeRoom(codeInput.value);
    setStatus(joinStatus, '');
  });
  codeInput.addEventListener('paste', (event) => {
    event.preventDefault();
    codeInput.value = sanitizeRoom((event.clipboardData || window.clipboardData).getData('text'));
    setStatus(joinStatus, '');
  });

  document.querySelector('[data-logout]').addEventListener('click', () => {
    fetch('/logout', { method: 'POST' }).finally(() => { location.href = '/login'; });
  });

  document.getElementById('save-name').addEventListener('click', async () => {
    const status = document.getElementById('name-status');
    setStatus(status, '');
    const res = await fetch('/api/me', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: document.getElementById('display-name').value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(status, body.error === 'name_locked' ? 'Your name is already set.' : 'Use 2–24 letters or numbers.', 'error');
      return;
    }
    setStatus(status, 'Saved.', 'success');
    document.getElementById('profile').hidden = true;
    const identity = document.querySelector('[data-user-label]');
    identity.textContent = body.name;
  });

  fetch('/version.json')
    .then((response) => response.json())
    .then((info) => {
      if (!info?.version || !window.DuetExtensionStatus) return;
      window.DuetExtensionStatus.refresh(info);
      document.getElementById('ext-action').addEventListener('click', () => {
        window.DuetExtensionStatus.runInstall(location.origin, info);
      });
    })
    .catch(() => {});

  window.addEventListener('duet:languagechange', () => {
    if (joinStatus.textContent) setStatus(joinStatus, t('invalidCode'), joinStatus.dataset.state);
  });

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  if (!reducedMotion.matches) {
    let ticking = false;
    const updateScroll = () => {
      const y = Math.min(window.scrollY, window.innerHeight);
      document.documentElement.style.setProperty('--hero-scroll', String(y));
      document.querySelector('[data-header]').classList.toggle('is-scrolled', window.scrollY > 24);
      ticking = false;
    };
    addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(updateScroll);
        ticking = true;
      }
    }, { passive: true });
    updateScroll();

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.16 });
    document.querySelectorAll('.story-steps li, .setup-card, .device-card').forEach((node) => {
      node.classList.add('reveal-ready');
      observer.observe(node);
    });
  }

  loadSession();
})();
