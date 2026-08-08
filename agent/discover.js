'use strict';

/**
 * Roku answers SSDP on the local subnet. Android TV and Apple TV do not
 * advertise a control interface this way — Apple TV is found with pyatv's
 * `atvscan`, and Android TV needs an IP you set in its network settings.
 */

const dgram = require('dgram');

const PROBE = [
  'M-SEARCH * HTTP/1.1',
  'HOST: 239.255.255.250:1900',
  'MAN: "ssdp:discover"',
  'ST: roku:ecp',
  'MX: 3',
  '',
  '',
].join('\r\n');

function discoverRoku({ timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const hosts = new Map();

    socket.on('message', async (buf) => {
      const text = buf.toString();
      const location = /LOCATION:\s*(\S+)/i.exec(text)?.[1];
      if (!location) return;
      const host = new URL(location).hostname;
      if (hosts.has(host)) return;
      hosts.set(host, { host, name: host });

      try {
        const res = await fetch(`http://${host}:8060/query/device-info`, {
          signal: AbortSignal.timeout(2500),
        });
        const xml = await res.text();
        const name =
          /<user-device-name>(.*?)<\/user-device-name>/.exec(xml)?.[1] ||
          /<model-name>(.*?)<\/model-name>/.exec(xml)?.[1];
        if (name) hosts.set(host, { host, name });
      } catch {
        /* keep the bare IP */
      }
    });

    socket.on('error', () => {
      try { socket.close(); } catch {}
      resolve([]);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(PROBE, 1900, '239.255.255.250');
    });

    setTimeout(() => {
      try { socket.close(); } catch {}
      resolve([...hosts.values()]);
    }, timeoutMs);
  });
}

module.exports = { discoverRoku };
