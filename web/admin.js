'use strict';

const $ = (id) => document.getElementById(id);

function when(ts) {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ts));
  } catch {
    return '';
  }
}

function initial(name, email) {
  const source = String(name || email || '?').trim();
  return (source[0] || '?').toUpperCase();
}

function shareCopy(kind, email, url) {
  if (kind === 'reset') {
    return {
      subject: 'Reset your Duet password',
      text: `Use this link to set a new Duet password. It expires in 24 hours.\n\n${url}`,
    };
  }
  return {
    subject: "You're invited to Duet",
    text: `You're invited to Duet. Open this link to choose a name and password. It expires in 7 days.\n\n${url}`,
  };
}

function renderShare(panel, { kind, email, url }) {
  const absolute = new URL(url, location.origin).href;
  const copy = shareCopy(kind, email, absolute);
  const sms = `sms:?&body=${encodeURIComponent(copy.text)}`;
  const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(copy.subject)}&body=${encodeURIComponent(copy.text)}`;

  panel.hidden = false;
  panel.replaceChildren();

  const title = document.createElement('p');
  title.className = 'small';
  const strong = document.createElement('strong');
  strong.textContent = email;
  title.append(
    document.createTextNode(kind === 'reset' ? 'Password reset link for ' : 'Invite ready for '),
    strong,
    document.createTextNode(kind === 'reset' ? '. Share it now — it expires in 24 hours.' : '. Share it now — it expires in 7 days.')
  );

  const urlEl = document.createElement('p');
  urlEl.className = 'invite-url';
  urlEl.textContent = absolute;

  const actions = document.createElement('div');
  actions.className = 'row share-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn compact';
  copyBtn.textContent = 'Copy link';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(absolute);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1600);
    } catch {
      copyBtn.textContent = 'Copy failed';
    }
  });

  const messages = document.createElement('a');
  messages.className = 'btn compact';
  messages.href = sms;
  messages.textContent = 'Messages';

  const emailBtn = document.createElement('a');
  emailBtn.className = 'btn compact';
  emailBtn.href = mailto;
  emailBtn.textContent = 'Email';

  actions.append(copyBtn, messages, emailBtn);

  if (navigator.share) {
    const web = document.createElement('button');
    web.type = 'button';
    web.className = 'btn compact';
    web.textContent = 'Share…';
    web.addEventListener('click', () => {
      navigator.share({ title: copy.subject, text: copy.text, url: absolute }).catch(() => {});
    });
    actions.append(web);
  }

  panel.append(title, urlEl, actions);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function pill(text, tone) {
  const el = document.createElement('span');
  el.className = `pill${tone ? ` pill-${tone}` : ''}`;
  el.textContent = text;
  return el;
}

function actionButton(label, className, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401 || res.status === 403) {
    location.href = '/login';
    return null;
  }
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function emptyState(text) {
  const p = document.createElement('p');
  p.className = 'small people-empty';
  p.textContent = text;
  return p;
}

function memberRow(user) {
  const row = document.createElement('article');
  row.className = 'person';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = initial(user.name, user.email);

  const meta = document.createElement('div');
  meta.className = 'person-meta';
  const name = document.createElement('div');
  name.className = 'person-name';
  name.textContent = user.name || user.email;
  const email = document.createElement('div');
  email.className = 'person-email';
  email.textContent = user.email;
  meta.append(name, email);

  const tags = document.createElement('div');
  tags.className = 'person-tags';
  tags.append(pill(user.role === 'owner' ? 'Owner' : 'Member', user.role === 'owner' ? 'lamp' : ''));
  tags.append(pill(user.disabled ? 'Disabled' : 'Active', user.disabled ? 'rose' : 'good'));
  if (user.createdAt) {
    const joined = document.createElement('span');
    joined.className = 'person-joined';
    joined.textContent = `Joined ${when(user.createdAt)}`;
    tags.append(joined);
  }

  const actions = document.createElement('div');
  actions.className = 'person-actions';
  if (user.role !== 'owner') {
    actions.append(
      actionButton(user.disabled ? 'Enable' : 'Disable', 'btn compact', () => toggleUser(user)),
      actionButton('Reset password', 'btn compact', () => resetUser(user)),
      actionButton('Delete', 'btn compact danger', () => deleteUser(user))
    );
  } else {
    const note = document.createElement('span');
    note.className = 'small';
    note.textContent = 'Owner account';
    actions.append(note);
  }

  row.append(avatar, meta, tags, actions);
  return row;
}

function pendingRow(invite) {
  const row = document.createElement('article');
  row.className = 'person';

  const avatar = document.createElement('div');
  avatar.className = 'avatar avatar-pending';
  avatar.textContent = initial(invite.email);

  const meta = document.createElement('div');
  meta.className = 'person-meta';
  const name = document.createElement('div');
  name.className = 'person-name';
  name.textContent = invite.email;
  const sub = document.createElement('div');
  sub.className = 'person-email';
  sub.textContent = invite.expiresAt ? `Expires ${when(invite.expiresAt)}` : 'Pending invite';
  meta.append(name, sub);

  const tags = document.createElement('div');
  tags.className = 'person-tags';
  tags.append(pill('Pending', 'lamp'));

  const actions = document.createElement('div');
  actions.className = 'person-actions';
  actions.append(actionButton('Resend link', 'btn compact primary', () => resendInvite(invite.email)));

  row.append(avatar, meta, tags, actions);
  return row;
}

async function refresh() {
  const data = await api('/api/invites');
  if (!data || !data.ok) return;
  const members = $('members');
  const pending = $('pending');
  members.replaceChildren();
  pending.replaceChildren();

  const users = data.body.users || [];
  const invites = data.body.invites || [];
  if (!users.length) members.append(emptyState('No members yet. Send an invite above.'));
  else users.forEach((user) => members.append(memberRow(user)));

  if (!invites.length) pending.append(emptyState('No open invites.'));
  else invites.forEach((invite) => pending.append(pendingRow(invite)));
}

async function createInvite(email) {
  $('invite-error').textContent = '';
  const data = await api('/api/invites', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  if (!data) return;
  if (!data.ok) {
    $('invite-error').textContent = data.body.error === 'already_registered'
      ? 'That email already has access.'
      : data.body.error === 'invalid_email'
        ? 'Enter a valid email address.'
        : 'Could not create invite.';
    return;
  }
  renderShare($('share-panel'), { kind: 'invite', email: data.body.email, url: data.body.url });
  $('email').value = '';
  await refresh();
}

async function resendInvite(email) {
  await createInvite(email);
}

async function toggleUser(user) {
  const action = user.disabled ? 'enable' : 'disable';
  const data = await api(`/api/users/${user.id}/${action}`, { method: 'POST' });
  if (!data) return;
  if (!data.ok) {
    $('invite-error').textContent = 'Could not update that person.';
    return;
  }
  await refresh();
}

async function resetUser(user) {
  const data = await api(`/api/users/${user.id}/reset`, { method: 'POST' });
  if (!data) return;
  if (!data.ok) {
    $('invite-error').textContent = 'Could not create a reset link.';
    return;
  }
  renderShare($('share-panel'), { kind: 'reset', email: data.body.email, url: data.body.url });
}

async function deleteUser(user) {
  const ok = window.confirm(`Permanently delete ${user.name || user.email}? They will lose access immediately.`);
  if (!ok) return;
  const data = await api(`/api/users/${user.id}`, { method: 'DELETE' });
  if (!data) return;
  if (!data.ok) {
    $('invite-error').textContent = 'Could not delete that person.';
    return;
  }
  await refresh();
}

$('invite-form').addEventListener('submit', (event) => {
  event.preventDefault();
  createInvite($('email').value);
});

refresh();
