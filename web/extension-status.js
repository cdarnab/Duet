/* One-click install: Chrome writes the extension folder on this Mac.
   Updates reuse the saved folder. Chrome still needs Load unpacked once. */
(function () {
  const DB_NAME = 'duet-extension';
  const STORE = 'handles';

  function cmpVersion(a, b) {
    const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function pingExtension(id) {
    return new Promise((resolve) => {
      if (!id || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve(null);
        return;
      }
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        chrome.runtime.sendMessage(id, { type: 'duetPing' }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) done(null);
          else done(res);
        });
      } catch {
        done(null);
      }
      setTimeout(() => done(null), 800);
    });
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveDirHandle(handle) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, 'dir');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadDirHandle() {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get('dir');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async function hasWriteAccess(handle) {
    if (!handle || !handle.queryPermission) return false;
    try {
      return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      return false;
    }
  }

  async function requestWriteAccess(handle) {
    if (!handle || !handle.requestPermission) return false;
    try {
      return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      return false;
    }
  }

  async function readFolderVersion(handle) {
    if (!handle) return null;
    try {
      let dir = handle;
      try {
        await dir.getFileHandle('manifest.json');
      } catch {
        dir = await dir.getDirectoryHandle('extension');
      }
      const file = await (await dir.getFileHandle('manifest.json')).getFile();
      const manifest = JSON.parse(await file.text());
      return manifest.version || null;
    } catch {
      return null;
    }
  }

  async function writeFiles(rootHandle, files, origin) {
    let dest = rootHandle;
    try {
      await rootHandle.getFileHandle('manifest.json');
    } catch {
      dest = await rootHandle.getDirectoryHandle('extension', { create: true });
    }
    for (const rel of files) {
      const parts = rel.split('/').filter(Boolean);
      let dir = dest;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i], { create: true });
      }
      const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await fileHandle.createWritable();
      const res = await fetch(`${origin}/extension-dist/${parts.map(encodeURIComponent).join('/')}`);
      if (!res.ok) throw new Error(`Could not download ${rel}`);
      await writable.write(await res.blob());
      await writable.close();
    }
  }

  function setStatus({ title, button, disabled, hint, showSteps }) {
    document.getElementById('ext-status').textContent = title;
    const action = document.getElementById('ext-action');
    action.textContent = button;
    action.disabled = Boolean(disabled);
    document.getElementById('ext-hint').textContent = hint || '';
    document.getElementById('ext-steps').hidden = !showSteps;
  }

  async function refresh(info) {
    const latest = info.version || '0';
    document.getElementById('ext-version').textContent = 'v' + latest;
    document.querySelectorAll('.ext-version-copy').forEach((el) => { el.textContent = latest; });

    const loaded = await pingExtension(info.id);
    const handle = await loadDirHandle();
    const folderVersion = (handle && await hasWriteAccess(handle)) ? await readFolderVersion(handle) : null;
    const installedVersion = loaded?.version || folderVersion;

    if (loaded && cmpVersion(loaded.version, latest) >= 0) {
      setStatus({
        title: 'Extension up to date',
        button: 'Extension up to date',
        disabled: true,
        hint: `Chrome is running Duet v${loaded.version}.`,
        showSteps: false,
      });
      return 'current';
    }
    if (installedVersion && cmpVersion(installedVersion, latest) < 0) {
      setStatus({
        title: 'Extension already installed but not up to date',
        button: 'Update extension',
        hint: `This Mac has v${installedVersion}. Latest is v${latest}. One click updates the folder; then Reload on chrome://extensions.`,
        showSteps: false,
      });
      return 'outdated';
    }
    if (folderVersion && !loaded) {
      setStatus({
        title: 'Extension files are installed',
        button: 'Install Extension',
        hint: 'Finish once in Chrome: chrome://extensions → Developer mode → Load unpacked → pick the Duet/extension folder you just saved.',
        showSteps: true,
      });
      return 'finish';
    }
    setStatus({
      title: 'Install Extension',
      button: 'Install Extension',
      hint: 'One click saves the extension on this Mac. Chrome still needs Load unpacked the first time.',
      showSteps: true,
    });
    return 'missing';
  }

  async function runInstall(origin, info) {
    const hint = document.getElementById('ext-hint');
    const box = document.getElementById('install-cmd');
    if (box) box.hidden = true;

    if (!window.showDirectoryPicker) {
      hint.textContent = 'This browser cannot save a folder directly. Download the zip, unzip it, then Load unpacked.';
      window.location.href = '/duet-extension.zip';
      return;
    }

    hint.textContent = 'Choose or create a folder named Duet (Documents is best)…';
    try {
      let dir = await loadDirHandle();
      if (!dir || !(await requestWriteAccess(dir))) {
        dir = await window.showDirectoryPicker({
          id: 'duet-extension',
          mode: 'readwrite',
          startIn: 'documents',
        });
      }
      await saveDirHandle(dir);
      hint.textContent = 'Saving files…';
      const listing = await fetch(`${origin}/api/extension/files`).then((res) => {
        if (!res.ok) throw new Error('Could not list extension files');
        return res.json();
      });
      await writeFiles(dir, listing.files, origin);
      hint.textContent = dir.name === 'extension'
        ? `Saved. First time only: chrome://extensions → Load unpacked → pick “${dir.name}”. Later, just click Update and then Reload.`
        : `Saved into “${dir.name}/extension”. First time only: chrome://extensions → Load unpacked → ${dir.name} → extension. Later, just click Update and then Reload.`;
      document.getElementById('ext-steps').hidden = false;
      if (info) await refresh(info);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        hint.textContent = 'Install cancelled.';
        return;
      }
      hint.textContent = 'Could not save the folder. Try again, or download the zip instead.';
    }
  }

  window.DuetExtensionStatus = { refresh, runInstall };
})();
