/* global DuetSync */
/**
 * Browser-side room client. Handles the socket, clock alignment, roster,
 * chat, cues, and optional voice. Emits events; the pages decide what to draw.
 */
(function (root) {
  const { ClockSync } = root.DuetSync;

  class DuetClient extends EventTarget {
    constructor({ room, name, surface, url }) {
      super();
      this.room = (room || '').toUpperCase();
      this.name = name || 'Guest';
      this.surface = surface || 'companion';
      this.url = url || defaultSocketUrl();
      this.clock = new ClockSync();
      this.selfId = null;
      this.members = new Map();
      this.state = { paused: true, position: 0, rate: 1, atServerTime: Date.now(), seq: 0 };
      this.connected = false;
      this._backoff = 500;
      this._pingTimer = null;
      this._pc = null;
      this._localStream = null;
    }

    connect() {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', () => {
        this.connected = true;
        this._backoff = 500;
        this._send({ type: 'hello', room: this.room, name: this.name, surface: this.surface });
        this._startClock();
        this.emit('status', { connected: true });
      });
      this.socket.addEventListener('message', (ev) => this._onMessage(JSON.parse(ev.data)));
      this.socket.addEventListener('close', () => {
        this.connected = false;
        clearInterval(this._pingTimer);
        this.emit('status', { connected: false });
        setTimeout(() => this.connect(), this._backoff);
        this._backoff = Math.min(8000, this._backoff * 1.8);
      });
      this.socket.addEventListener('error', () => this.socket.close());
      return this;
    }

    emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }

    on(type, fn) {
      this.addEventListener(type, (e) => fn(e.detail));
      return this;
    }

    _send(msg) {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(msg));
      }
    }

    _startClock() {
      const beat = () => this._send({ type: 'ping', t0: Date.now() });
      beat();
      // Fast at first to converge, then keep a slow trickle against clock drift.
      let n = 0;
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => {
        n++;
        if (n < 6 || n % 10 === 0) beat();
      }, 1000);
    }

    _onMessage(msg) {
      switch (msg.type) {
        case 'pong':
          this.clock.addSample(msg.t0, msg.t1, Date.now());
          this.emit('clock', { offset: this.clock.offset, rtt: this.clock.rtt, ready: this.clock.ready });
          break;
        case 'welcome':
          this.selfId = msg.selfId;
          this.room = msg.room;
          this.state = msg.state;
          this.members = new Map(msg.members.map((m) => [m.id, m]));
          this.emit('welcome', msg);
          this.emit('roster', this.roster());
          break;
        case 'joined':
          this.members.set(msg.member.id, msg.member);
          this.emit('roster', this.roster());
          this.emit('joined', msg.member);
          break;
        case 'left':
          this.members.delete(msg.id);
          this.emit('roster', this.roster());
          break;
        case 'state':
          this.state = msg.state;
          this.emit('state', msg);
          if (msg.resync) this.emit('resync', msg);
          break;
        case 'tick': {
          const m = this.members.get(msg.id);
          if (m) Object.assign(m, { position: msg.position, paused: msg.paused, title: msg.title });
          this.emit('roster', this.roster());
          break;
        }
        case 'chat':
          this.emit('chat', msg.entry);
          break;
        case 'cue':
          this.emit('cue', msg);
          break;
        case 'signal':
          this._onSignal(msg);
          break;
      }
    }

    roster() {
      return [...this.members.values()];
    }

    partners() {
      return this.roster().filter((m) => m.id !== this.selfId);
    }

    serverNow() {
      return this.clock.now();
    }

    /** Where the room says the movie should be right now. */
    expectedPosition() {
      return root.DuetSync.projected(this.state, this.serverNow());
    }

    setState({ paused, position, rate = 1, source, title }) {
      this._send({ type: 'state', paused, position, rate, source, title });
    }

    tick(position, paused, title) {
      this._send({ type: 'tick', position, paused, title });
    }

    resync() {
      this._send({ type: 'resync' });
    }

    chat(text) {
      this._send({ type: 'chat', text });
    }

    /** Fire a shared countdown so both sides press play on the same beat. */
    cue(inMs = 3000, position) {
      this._send({ type: 'cue', inMs, position });
    }

    /* ------------------------------------------------------------- voice */

    async startVoice() {
      if (this._pc) return;
      this._localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const peer = this.partners()[0];
      this._makePeer(peer ? peer.id : null, true);
      this.emit('voice', { active: true });
    }

    stopVoice() {
      this._pc?.close();
      this._pc = null;
      this._localStream?.getTracks().forEach((t) => t.stop());
      this._localStream = null;
      this.emit('voice', { active: false });
    }

    setMuted(muted) {
      this._localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    }

    _makePeer(remoteId, initiator) {
      this._remoteId = remoteId;
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
      });
      this._pc = pc;
      this._localStream?.getTracks().forEach((t) => pc.addTrack(t, this._localStream));
      pc.ontrack = (ev) => this.emit('remoteaudio', ev.streams[0]);
      pc.onicecandidate = (ev) => {
        if (ev.candidate && this._remoteId) {
          this._send({ type: 'signal', to: this._remoteId, data: { candidate: ev.candidate } });
        }
      };
      pc.onconnectionstatechange = () => this.emit('voicestate', pc.connectionState);
      if (initiator && remoteId) {
        pc.createOffer().then(async (offer) => {
          await pc.setLocalDescription(offer);
          this._send({ type: 'signal', to: remoteId, data: { sdp: pc.localDescription } });
        });
      }
    }

    async _onSignal(msg) {
      const { from, data } = msg;
      if (!this._pc) {
        if (!this._localStream) return; // voice not started on this side
        this._makePeer(from, false);
      }
      this._remoteId = from;
      if (data.sdp) {
        await this._pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await this._pc.createAnswer();
          await this._pc.setLocalDescription(answer);
          this._send({ type: 'signal', to: from, data: { sdp: this._pc.localDescription } });
        }
      } else if (data.candidate) {
        try {
          await this._pc.addIceCandidate(data.candidate);
        } catch {
          /* candidate arrived before the description; safe to drop */
        }
      }
    }
  }

  function defaultSocketUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  root.DuetClient = DuetClient;
})(window);
