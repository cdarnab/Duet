'use strict';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1 — these get read aloud

function makeCode(len = 6) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return out;
}

class Member {
  constructor(id, socket) {
    this.id = id;
    this.socket = socket;
    this.name = 'Guest';
    this.surface = 'unknown'; // 'browser' | 'tv' | 'companion'
    this.position = 0;
    this.paused = true;
    this.lastSeen = Date.now();
    this.title = null;
  }

  toPublic() {
    return {
      id: this.id,
      name: this.name,
      surface: this.surface,
      position: this.position,
      paused: this.paused,
      title: this.title,
      lastSeen: this.lastSeen,
    };
  }
}

class Room {
  constructor(code) {
    this.code = code;
    this.members = new Map();
    this.chat = [];
    this.createdAt = Date.now();
    this.state = {
      paused: true,
      position: 0,
      rate: 1,
      atServerTime: Date.now(),
      source: null, // optional direct media URL for the TV client
      title: null,
      updatedBy: null,
      seq: 0,
    };
  }

  get size() {
    return this.members.size;
  }

  add(member) {
    this.members.set(member.id, member);
  }

  remove(id) {
    this.members.delete(id);
  }

  /** Apply a state change from a member and stamp it with server time. */
  applyState(patch, byId) {
    const next = { ...this.state, ...patch };
    next.atServerTime = Number.isFinite(patch.atServerTime) ? patch.atServerTime : Date.now();
    next.position = Math.max(0, Number(next.position) || 0);
    next.paused = Boolean(next.paused);
    next.rate = Number(next.rate) || 1;
    next.updatedBy = byId;
    next.seq = this.state.seq + 1;
    this.state = next;
    return this.state;
  }

  pushChat(entry) {
    this.chat.push(entry);
    if (this.chat.length > 200) this.chat.shift();
    return entry;
  }

  roster() {
    return [...this.members.values()].map((m) => m.toPublic());
  }
}

class RoomStore {
  constructor() {
    this.rooms = new Map();
  }

  create() {
    let code = makeCode();
    while (this.rooms.has(code)) code = makeCode();
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  /** Join-or-create, so a shared link always works even after a server restart. */
  ensure(code) {
    const key = String(code || '').toUpperCase().trim();
    if (!key) return this.create();
    if (!this.rooms.has(key)) this.rooms.set(key, new Room(key));
    return this.rooms.get(key);
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase().trim());
  }

  /** Drop empty rooms after a grace period so a reload doesn't lose the room. */
  sweep(maxIdleMs = 1000 * 60 * 30, now = Date.now()) {
    let dropped = 0;
    for (const [code, room] of this.rooms) {
      if (room.size === 0 && now - room.state.atServerTime > maxIdleMs) {
        this.rooms.delete(code);
        dropped++;
      }
    }
    return dropped;
  }
}

module.exports = { Room, RoomStore, Member, makeCode };
