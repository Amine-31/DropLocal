// DropLocal — Step 4.5: sticky device names (server: presence + signaling only).
//
// How it works:
//   - Express serves the ./public folder (the frontend).
//   - A WebSocket endpoint at /ws groups clients into "rooms" by network.
//   - Each client gets a random id; its name is the valid, room-unique `?name=`
//     it sent, or a random human-readable name (e.g. "Blue Fox") otherwise.
//   - The client sends its User-Agent as `?ua=` on connect; the server stores
//     it and includes it in device lists so peers can show a device icon
//     (phone / tablet / computer). The UA is treated as an opaque,
//     length-capped string — no rooms / relay / transfer logic depends on it.
//   - On join/leave, every client in the same room gets the updated device list.
//   - Clients exchange WebRTC offer/answer/ICE via "signal" messages which the
//     server relays blindly (it never inspects `data`).

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Random display names ("Blue Fox", "Quiet Panda", ...)
// ---------------------------------------------------------------------------

const ADJECTIVES = [
  'Amber', 'Blue', 'Brave', 'Bright', 'Calm', 'Clever', 'Cosmic', 'Crimson',
  'Gentle', 'Golden', 'Green', 'Happy', 'Ivory', 'Jolly', 'Kind', 'Lucky',
  'Misty', 'Nimble', 'Purple', 'Quiet', 'Red', 'Silent', 'Silver', 'Swift',
];

const ANIMALS = [
  'Badger', 'Bear', 'Deer', 'Dolphin', 'Eagle', 'Falcon', 'Fox', 'Frog',
  'Hawk', 'Heron', 'Koala', 'Lion', 'Otter', 'Owl', 'Panda', 'Penguin',
  'Tiger', 'Turtle', 'Whale', 'Wolf',
];

function randomName() {
  const adj = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)];
  const animal = ANIMALS[crypto.randomInt(ANIMALS.length)];
  return `${adj} ${animal}`;
}

// ---------------------------------------------------------------------------
// Rooms: Map<roomKey, Map<clientId, { id, name, ua, ws }>>.
//
//   - Private / local addresses (127.0.0.1, ::1, 10.x, 192.168.x, 172.16-31.x)
//     all share ONE room called "local", so testing on a LAN works: every
//     device behind the same router (plus localhost test tabs) sees each other.
//   - Any other (public) IP gets one room per IP — the Snapdrop trick where
//     two browsers behind the same NAT share a public IP and discover
//     each other.
// ---------------------------------------------------------------------------

/** Room key shared by all LAN / loopback clients (easy local testing). */
const LOCAL_ROOM = 'local';

/** All active rooms, keyed by room key ("local" or a public IP). */
const rooms = new Map();

/** Strip IPv6-mapped IPv4 prefix (e.g. "::ffff:1.2.3.4" -> "1.2.3.4"). */
function normalizeIp(ip) {
  if (!ip) return 'unknown';
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length);
  return ip;
}

/**
 * True for loopback + RFC 1918 private ranges, which all share the "local"
 * room. Everything else (public IPs, "unknown") gets per-IP rooms.
 */
function isLocalAddress(ip) {
  if (ip === '::1' || ip === 'localhost') return true;
  if (ip === '127.0.0.1' || ip.startsWith('127.')) return true; // 127/8 loopback
  if (/^10\.\d+\.\d+\.\d+$/.test(ip)) return true; // 10.0.0.0/8
  if (/^192\.168\.\d+\.\d+$/.test(ip)) return true; // 192.168.0.0/16
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ip)) return true; // 172.16.0.0/12
  return false;
}

/**
 * Resolve the client's public IP for room grouping.
 * Trusts `x-forwarded-for` (set by proxies / hosting platforms) when
 * present, otherwise falls back to the raw socket address.
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    // Format: "client, proxy1, proxy2" — the first entry is the client.
    return normalizeIp(forwarded.split(',')[0].trim());
  }
  return normalizeIp(req.socket && req.socket.remoteAddress);
}

/**
 * Map a client IP to its room key: "local" for LAN/loopback, else the IP.
 * Public IPs still get one room per IP.
 */
function roomKeyForIp(ip) {
  return isLocalAddress(ip) ? LOCAL_ROOM : ip;
}

/**
 * Read the client's User-Agent sent as `?ua=` on the WebSocket URL. Stored
 * and forwarded verbatim (capped) so peers can pick a device icon. Clients
 * that don't send one (old tabs, scripts) get an empty string.
 */
function getClientUa(req) {
  try {
    const ua = new URL(req.url || '', 'http://localhost').searchParams.get('ua');
    if (typeof ua !== 'string') return '';
    return ua.slice(0, 512);
  } catch {
    return '';
  }
}

/** Snapshot of everyone currently in a room (safe to send to clients). */
function getRoomDevices(room) {
  return [...room.values()].map((client) => ({ id: client.id, name: client.name, ua: client.ua }));
}

/** Push the current device list to every open socket in the room. */
function broadcastDeviceList(roomKey) {
  const room = rooms.get(roomKey);
  if (!room) return;
  const payload = JSON.stringify({ type: 'devices', devices: getRoomDevices(room) });
  for (const client of room.values()) {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(payload);
    }
  }
}

/** Pick a name that isn't already taken in this room (gives up after N tries). */
function uniqueNameInRoom(room) {
  const taken = new Set([...room.values()].map((c) => c.name));
  for (let i = 0; i < 50; i++) {
    const candidate = randomName();
    if (!taken.has(candidate)) return candidate;
  }
  // Extremely unlikely fallback: suffix to guarantee uniqueness.
  return `${randomName()} ${crypto.randomInt(100, 999)}`;
}

/**
 * Read the client's requested device name sent as `?name=` on the WebSocket
 * URL. Valid names are 1–30 chars of letters, numbers and spaces (and not
 * blank). Anything else yields null — the caller falls back to random.
 */
function getRequestedName(req) {
  try {
    const raw = new URL(req.url || '', 'http://localhost').searchParams.get('name');
    if (typeof raw !== 'string') return null;
    if (!/^[A-Za-z0-9 ]{1,30}$/.test(raw)) return null;
    if (raw.trim().length === 0) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Honor a requested name when it is valid and free in this room; otherwise
 * hand out a random name for this session only (the request is forgotten —
 * nothing is stored beyond the session's own record).
 */
function claimName(room, requested) {
  if (requested !== null) {
    const taken = new Set([...room.values()].map((c) => c.name));
    if (!taken.has(requested)) return requested;
  }
  return uniqueNameInRoom(room);
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const app = express();

// Serve the frontend. `index.html` inside ./public is served at `/`.
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// Dedicated WebSocket endpoint — the frontend connects to `ws(s)://host/ws`.
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  // 1. Figure out which room this socket belongs to.
  const clientIp = getClientIp(req);
  const roomKey = roomKeyForIp(clientIp);

  if (!rooms.has(roomKey)) {
    rooms.set(roomKey, new Map());
  }
  const room = rooms.get(roomKey);

  // 2. Assign identity (+ remember the UA string for the device list).
  // A valid, room-unique `?name=` is honored; otherwise the session gets a
  // random name. Either way the name is returned in the hello message.
  const id = crypto.randomUUID();
  const name = claimName(room, getRequestedName(req));
  const ua = getClientUa(req);
  room.set(id, { id, name, ua, ws });

  // Stash for cleanup on disconnect.
  ws._roomKey = roomKey;
  ws._clientId = id;

  console.log(`[join] ${name} (${id}) ip=${clientIp} room="${roomKey}" — ${room.size} device(s)`);

  // 3. Tell the newcomer who they are...
  ws.send(JSON.stringify({ type: 'hello', you: { id, name } }));

  // 4. ...and tell everyone in the room (including the newcomer) who's here.
  broadcastDeviceList(roomKey);

  // Relay WebRTC signaling between peers in the same room.
  // Client sends { type: "signal", to, data }; we forward it as
  // { type: "signal", from, data } to the target ONLY if it shares our room.
  // `data` stays opaque — the server never reads it (offer/answer/ICE).
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // Ignore malformed payloads.
    }
    if (!msg || msg.type !== 'signal') return; // Unknown types are ignored.
    if (typeof msg.to !== 'string' || !('data' in msg)) return; // Malformed signal.

    const room = rooms.get(ws._roomKey);
    if (!room) return;
    const target = room.get(msg.to);
    // Same-room check: the target must be in OUR room. Anything else
    // (unknown id, different room, closed socket) is silently dropped so
    // clients can't probe or message other rooms.
    if (!target || target.ws.readyState !== target.ws.OPEN) return;

    target.ws.send(JSON.stringify({ type: 'signal', from: ws._clientId, data: msg.data }));
  });

  // 5. On disconnect, remove the client and refresh the room's device list.
  ws.on('close', () => {
    const r = rooms.get(ws._roomKey);
    if (r) {
      r.delete(ws._clientId);
      console.log(`[leave] ${name} (${id}) left room "${ws._roomKey}" — ${r.size} device(s)`);
      if (r.size === 0) {
        rooms.delete(ws._roomKey); // Drop empty rooms to avoid a memory leak.
      } else {
        broadcastDeviceList(ws._roomKey);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[ws error] ${name} (${id}):`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`DropLocal listening on http://localhost:${PORT}`);
});
