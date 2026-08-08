/* Detects the loaded Duet extension and installs/updates it into
   ~/Library/Application Support/Duet/extension on every Mac. */
(function () {
  const INSTALL_DIR = '~/Library/Application Support/Duet/extension';

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

  function installCommand(origin) {
    return [
      `mkdir -p "$HOME/Library/Application Support/Duet/extension"`,
      `curl -fsSL "${origin}/duet-extension.zip" -o /tmp/duet-extension.zip`,
      `unzip -o /tmp/duet-extension.zip -d "$HOME/Library/Application Support/Duet/extension"`,
      `open "$HOME/Library/Application Support/Duet/extension"`,
    ].join(' && \\\n  ');
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

    const installed = await pingExtension(info.id);
    if (!installed) {
      setStatus({
        title: 'Install Extension',
        button: 'Install Extension',
        hint: `Files go here on every Mac: ${INSTALL_DIR}. Chrome still needs Load unpacked the first time.`,
        showSteps: true,
      });
      return 'missing';
    }
    if (cmpVersion(installed.version, latest) < 0) {
      setStatus({
        title: 'Extension already installed but not up to date',
        button: 'Update extension',
        hint: `This Mac has v${installed.version}. Latest is v${latest}. Update overwrites ${INSTALL_DIR}, then click Reload on chrome://extensions.`,
        showSteps: false,
      });
      return 'outdated';
    }
    setStatus({
      title: 'Extension up to date',
      button: 'Extension up to date',
      disabled: true,
      hint: `Loaded v${installed.version} from ${INSTALL_DIR}.`,
      showSteps: false,
    });
    return 'current';
  }

  async function runInstall(origin) {
    const cmd = installCommand(origin);
    const box = document.getElementById('install-cmd');
    box.hidden = false;
    box.textContent = cmd;
    try {
      await navigator.clipboard.writeText(cmd);
      document.getElementById('ext-hint').textContent =
        `Command copied. Paste it in Terminal, then Load unpacked from ${INSTALL_DIR} (or Reload if it is already loaded).`;
    } catch {
      document.getElementById('ext-hint').textContent =
        `Copy the command below into Terminal, then Load unpacked from ${INSTALL_DIR}.`;
    }
    const link = document.createElement('a');
    link.href = '/install-duet.sh';
    link.download = 'install-duet.sh';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  window.DuetExtensionStatus = { refresh, runInstall, installCommand, INSTALL_DIR };
})();
