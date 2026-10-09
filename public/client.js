// DropLocal frontend — Step 4: mobile-friendly file sharing.
//
// Signaling (JSON over ws(s)://host/ws?ua=<user-agent>&name=<device-name>):
//   <- { type: "hello", you: { id, name } }        // our identity (once per join)
//   <- { type: "devices", devices: [...] }         // full room list (join/leave);
//                                                  // entries carry { id, name, ua }
//   -> { type: "signal", to, data }                // opaque offer/answer/ICE
//   <- { type: "signal", from, data }              // relayed by the server
//
// Data channel ("droplocal", exactly one per peer pair):
//   - Text frames are JSON control messages:
//       -> { type: "file-offer", id, name, size, mime }  // sender starts
//       <- { type: "file-accept", id }                   // receiver accepts
//       <- { type: "file-decline", id }                  // receiver declines
//       -> raw binary ArrayBuffer chunks (16 KiB)        // after accept
//       -> { type: "file-end", id }                      // last byte sent
//     { type: "file-cancel", id } flows either way to abort a transfer.
//   - Binary frames carry the bytes of that peer's single active download.
//   - One file at a time per peer: picked files wait in an outbox queue and
//     the next offer goes out only after the previous transfer settles, so
//     binary frames can never interleave between two files.
//
// UX (Step 4): one tap on a device card connects (if needed) and opens the
// file picker; desktop users can also drag & drop files onto a card.

(function () {
  'use strict';

  // --- DOM ---------------------------------------------------------------
  const youEl = document.getElementById('you');
  const devicesEl = document.getElementById('devices');
  const emptyEl = document.getElementById('empty');
  const pageUrlEl = document.getElementById('page-url');
  const statusEl = document.getElementById('status');
  const statusTextEl = document.getElementById('status-text');
  const reconnectBanner = document.getElementById('reconnect-banner');
  const transfersEl = document.getElementById('transfers');
  const noTransfersEl = document.getElementById('no-transfers');
  const fileInput = document.getElementById('file-picker');
  const dropOverlay = document.getElementById('drop-overlay');
  const dropMessage = document.getElementById('drop-message');
  const dropPicker = document.getElementById('drop-picker');
  const dropCancel = document.getElementById('drop-cancel');

  // Our UA goes to the server as `?ua=` so peers can show a device icon.
  const MY_UA = typeof navigator !== 'undefined' && navigator.userAgent
    ? navigator.userAgent
    : '';

  if (pageUrlEl) pageUrlEl.textContent = location.href;

  // --- Lobby / peering state -----------------------------------------------
  let ws = null;
  let myId = null;
  let myName = '';
  let retryMs = 1000; // WS reconnect backoff, reset on successful hello
  let sentName = ''; // device name offered as ?name= on the current socket

  // Sticky device name: persisted on first join, offered on every connect.
  // localStorage may throw (private mode) — the app works fine without it.
  const DEVICE_NAME_KEY = 'droplocal.deviceName';
  function loadSavedName() {
    try {
      return localStorage.getItem(DEVICE_NAME_KEY) || '';
    } catch {
      return '';
    }
  }
  function saveDeviceName(name) {
    try {
      localStorage.setItem(DEVICE_NAME_KEY, name);
    } catch {
      /* storage unavailable: stay session-scoped */
    }
  }
  let devices = []; // other devices in our room: [{ id, name, ua }]
  const nameById = new Map(); // id -> last known display name (prompts, rows)
  const uaById = new Map(); // id -> last known User-Agent (device icons)
  // id -> { pc: RTCPeerConnection, channel: RTCDataChannel|null,
  //         state, drainResolver }
  // state is one of "connecting" | "connected" | "disconnected".
  const peers = new Map();

  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const CHANNEL_LABEL = 'droplocal';

  // --- File transfer tuning --------------------------------------------------
  const CHUNK_SIZE = 16 * 1024; // file.slice() window per binary frame
  const HIGH_WATER = 1024 * 1024; // pause sending while bufferedAmount above this
  const LOW_WATER = 256 * 1024; // …and resume on bufferedamountlow below this

  // --- File transfer state -----------------------------------------------------
  // One entry per file, both directions. Sender statuses: queued | waiting |
  // sending | done | declined | cancelled | failed. Receiver statuses:
  // incoming | receiving | done | declined | cancelled | failed.
  const transfersById = new Map(); // transfer id -> transfer object
  const transferOrder = []; // ids in creation order (render order)
  const sendQueues = new Map(); // peerId -> [transfer] (strictly sequential)
  const activeSendId = new Map(); // peerId -> transfer id with an open offer/send
  const pendingFiles = new Map(); // peerId -> File[] picked/dropped before connect
  let pickerPeerId = null; // recipient chosen by the open file picker

  // --- Small UI helpers ----------------------------------------------------------
  function setStatus(connected, text) {
    statusEl.classList.toggle('connected', connected);
    statusEl.classList.toggle('disconnected', !connected);
    statusTextEl.textContent = text;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatSpeed(bytesPerSec) {
    if (!isFinite(bytesPerSec) || bytesPerSec < 0) return '';
    if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
  }

  // Strip directories / control chars so a hostile name can't escape the
  // download or confuse the UI. Used for display AND the download attribute.
  function sanitizeFileName(name) {
    const base = String(name || '').split(/[\\/]/).pop();
    const clean = base.replace(/[\0-\x1F\x7F]/g, '').trim().replace(/^\.+/, '');
    return (clean || 'file').slice(0, 255);
  }

  // --- Device kinds (phone / tablet / desktop) --------------------------------------
  // Guessed from the UA string the server forwards for each device.
  function uaToKind(ua) {
    const s = String(ua || '');
    if (/ipad|tablet|playbook|silk(?!.*mobile)|kindle|nexus\s*(7|9|10)|sm-t\d|gt-p\d/i.test(s)) {
      return 'tablet';
    }
    // Most Android tablets omit the "Mobile" token that phones include.
    if (/android/i.test(s)) return /mobile/i.test(s) ? 'phone' : 'tablet';
    if (/iphone|ipod|mobile|phone|blackberry|bb10|windows phone|opera mini|iemobile/i.test(s)) {
      return 'phone';
    }
    const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1;
    if (touch) {
      // iPadOS in desktop mode reports a Mac UA — touch gives it away.
      if (/macintosh/i.test(s)) return 'tablet';
      const w = typeof window !== 'undefined' ? window.innerWidth : 0;
      const h = typeof window !== 'undefined' ? window.innerHeight : 0;
      if (w > 0 && h > 0 && Math.min(w, h) < 700) return 'phone';
    }
    return 'desktop';
  }

  const KIND_LABEL = { phone: 'Phone', tablet: 'Tablet', desktop: 'Computer' };

  // Static icon art (no user data inside — safe for innerHTML).
  const DEVICE_ICONS = {
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="10.5" y1="5" x2="13.5" y2="5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    tablet: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="2.5" width="15" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="18.5" r="1" fill="currentColor"/></svg>',
    desktop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="12.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="9" y1="20.5" x2="15" y2="20.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><line x1="12" y1="16.5" x2="12" y2="20.5" stroke="currentColor" stroke-width="1.8"/></svg>',
  };

  const STATE_TEXT = {
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnected: 'Disconnected',
  };

  function peerState(id) {
    const entry = peers.get(id);
    return entry ? entry.state : 'disconnected';
  }

  function setPeerState(id, state) {
    const entry = peers.get(id);
    if (entry) entry.state = state;
    renderDevices();
  }

  // Device list: each device is one big <button> card. Tapping it opens the
  // file picker and connects first if needed (see tapDevice). Desktop users
  // can also drag & drop files directly onto a card.
  // Names are rendered with textContent only (never innerHTML): a hostile
  // peer name can't inject markup. (Icon art is static — safe for innerHTML.)
  function renderDevices() {
    devicesEl.innerHTML = '';
    for (const device of devices) {
      const kind = uaToKind(uaById.get(device.id) || device.ua || '');
      const state = peerState(device.id);

      const li = document.createElement('li');

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'device';
      card.setAttribute('aria-label', `Send files to ${device.name} (${KIND_LABEL[kind]}, ${STATE_TEXT[state]})`);

      const icon = document.createElement('span');
      icon.className = 'device-icon';
      icon.setAttribute('data-icon', kind); // machine-readable kind (icons are visual)
      icon.innerHTML = DEVICE_ICONS[kind];

      const main = document.createElement('span');
      main.className = 'device-main';
      const name = document.createElement('span');
      name.className = 'device-name';
      name.textContent = device.name;
      const sub = document.createElement('span');
      sub.className = 'device-sub';
      sub.textContent = state === 'connecting'
        ? `${KIND_LABEL[kind]} · Connecting…`
        : `${KIND_LABEL[kind]} · Tap to send files`;
      main.appendChild(name);
      main.appendChild(sub);

      const badge = document.createElement('span');
      badge.className = `badge ${state}`;
      badge.textContent = STATE_TEXT[state];

      card.appendChild(icon);
      card.appendChild(main);
      card.appendChild(badge);
      card.addEventListener('click', () => tapDevice(device.id));

      // Desktop drag & drop (mobile browsers don't drag files — harmless there).
      card.addEventListener('dragover', (event) => {
        event.preventDefault(); // required to receive the drop
        card.classList.add('dragover');
      });
      card.addEventListener('dragleave', () => card.classList.remove('dragover'));
      card.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation(); // ours alone: the page-level handler must not re-send
        card.classList.remove('dragover');
        hideOverlay(); // a page drag may have raised the overlay behind us
        const files = event.dataTransfer && event.dataTransfer.files;
        if (files && files.length > 0) dropFiles(device.id, Array.from(files));
      });

      li.appendChild(card);
      devicesEl.appendChild(li);
    }
    emptyEl.style.display = devices.length === 0 ? '' : 'none';
  }

  // One tap does everything: the picker opens immediately (still inside the
  // user gesture, so the browser allows it) and the connection is started in
  // parallel when needed — picked files wait and send on channel open.
  function tapDevice(id) {
    pickerPeerId = id;
    fileInput.value = ''; // re-picking the same file still fires change
    fileInput.click();
    if (!openChannel(peers.get(id))) connectToPeer(id);
  }

  // Files dropped onto a card while offline wait, then send on channel open.
  function dropFiles(peerId, files) {
    if (files.length === 0) return;
    if (openChannel(peers.get(peerId))) enqueueFiles(peerId, files);
    else {
      stashPendingFiles(peerId, files);
      connectToPeer(peerId);
    }
  }

  function stashPendingFiles(peerId, files) {
    let pending = pendingFiles.get(peerId);
    if (!pending) {
      pending = [];
      pendingFiles.set(peerId, pending);
    }
    for (const file of files) pending.push(file);
  }

  // Channel just opened: flush anything picked/dropped while connecting.
  function flushPendingFiles(peerId) {
    const pending = pendingFiles.get(peerId);
    if (!pending || pending.length === 0) return;
    pendingFiles.delete(peerId);
    enqueueFiles(peerId, pending);
  }

  // --- Transfer list UI ------------------------------------------------------------
  const TRANSFER_STATUS_TEXT = {
    queued: 'Queued…',
    waiting: 'Waiting for accept…',
    incoming: 'Waiting for your response…',
    sending: 'Sending…',
    receiving: 'Receiving…',
    done: 'Done',
    declined: 'Declined',
    cancelled: 'Cancelled',
    failed: 'Failed',
  };

  function transferDoneBytes(t) {
    return t.dir === 'up' ? t.offset : t.received;
  }

  function transferProgress(t) {
    if (t.size === 0) return t.status === 'done' ? 100 : 0;
    return Math.min(100, Math.floor((transferDoneBytes(t) / t.size) * 100));
  }

  function transferSpeed(t) {
    if (t.startTime == null) return '';
    if (t.status !== 'sending' && t.status !== 'receiving') {
      if (t.status !== 'done' || t.endTime == null) return '';
    }
    const end = t.endTime != null ? t.endTime : Date.now();
    const elapsed = (end - t.startTime) / 1000;
    if (elapsed <= 0) return '';
    return formatSpeed(transferDoneBytes(t) / elapsed);
  }

  function statusLine(t) {
    let text = TRANSFER_STATUS_TEXT[t.status] || t.status;
    if (t.status === 'failed' && t.error) text += ` — ${t.error}`;
    const speed = transferSpeed(t);
    if (speed) text += ` · ${speed}`;
    return text;
  }

  // Full rebuild on structural changes (new transfer, state/button changes).
  // Per-chunk updates go through updateTransferProgress() to avoid rebuilding
  // the list hundreds of times per second.
  function renderTransfers() {
    transfersEl.innerHTML = '';
    for (const id of transferOrder) {
      const t = transfersById.get(id);
      if (!t) continue;

      const li = document.createElement('li');
      li.className = 'transfer';

      const head = document.createElement('div');
      head.className = 't-head';
      const arrow = document.createElement('span');
      arrow.className = 't-arrow';
      arrow.textContent = t.dir === 'up' ? '↑' : '↓';
      const name = document.createElement('span');
      name.className = 't-name';
      name.textContent = `${t.name} (${formatSize(t.size)})`;
      const peer = document.createElement('span');
      peer.className = 't-peer';
      peer.textContent = t.dir === 'up'
        ? `to ${nameById.get(t.peerId) || 'a device'}`
        : `from ${nameById.get(t.peerId) || 'a device'}`;
      head.appendChild(arrow);
      head.appendChild(name);
      head.appendChild(peer);

      const status = document.createElement('div');
      status.className = 't-status';
      status.textContent = statusLine(t);

      const bar = document.createElement('div');
      bar.className = 'progress';
      const fill = document.createElement('div');
      fill.className = 'fill';
      fill.style.width = `${transferProgress(t)}%`;
      bar.appendChild(fill);

      const actions = document.createElement('div');
      actions.className = 't-actions';
      if (t.status === 'incoming') {
        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'btn primary';
        accept.textContent = 'Accept';
        accept.setAttribute('aria-label', `Accept ${t.name}`);
        accept.addEventListener('click', () => acceptTransfer(t.id));
        const decline = document.createElement('button');
        decline.type = 'button';
        decline.className = 'btn';
        decline.textContent = 'Decline';
        decline.setAttribute('aria-label', `Decline ${t.name}`);
        decline.addEventListener('click', () => declineTransfer(t.id));
        actions.appendChild(accept);
        actions.appendChild(decline);
      } else if (t.status === 'waiting' || t.status === 'sending' || t.status === 'receiving') {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn danger';
        cancel.textContent = 'Cancel';
        cancel.setAttribute('aria-label', `Cancel ${t.name}`);
        cancel.addEventListener('click', () => cancelTransfer(t.id));
        actions.appendChild(cancel);
      } else if (t.status === 'done' && t.dir === 'down' && t.objectUrl) {
        const link = document.createElement('a');
        link.className = 'download';
        link.href = t.objectUrl;
        link.download = t.name;
        link.textContent = 'Download';
        actions.appendChild(link);
      }

      li.appendChild(head);
      li.appendChild(status);
      li.appendChild(bar);
      if (actions.childNodes.length > 0) li.appendChild(actions);
      transfersEl.appendChild(li);

      // Cache live nodes for cheap per-chunk updates.
      t._els = { fill, status };
    }
    noTransfersEl.style.display = transferOrder.length === 0 ? '' : 'none';
  }

  // Cheap per-chunk refresh: progress bar + status line only.
  function updateTransferProgress(t) {
    if (!t._els || !t._els.fill) {
      renderTransfers();
      return;
    }
    t._els.fill.style.width = `${transferProgress(t)}%`;
    t._els.status.textContent = statusLine(t);
  }

  function addTransfer(t) {
    transfersById.set(t.id, t);
    transferOrder.push(t.id);
    renderTransfers();
  }

  // --- Signaling ---------------------------------------------------------------------
  function sendSignal(to, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'signal', to, data }));
    }
  }

  // --- WebRTC --------------------------------------------------------------------------
  // Wake a sender paused on backpressure (drained, cancelled, or connection dead).
  function wakeDrain(entry) {
    if (entry && entry.drainResolver) {
      const resolve = entry.drainResolver;
      entry.drainResolver = null;
      resolve();
    }
  }

  function openChannel(entry) {
    return entry && entry.channel && entry.channel.readyState === 'open';
  }

  function sendControl(peerId, message) {
    const entry = peers.get(peerId);
    if (!openChannel(entry)) return false;
    try {
      entry.channel.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.warn('[file] control send failed:', err);
      return false;
    }
  }

  function setupDataChannel(id, channel) {
    channel.binaryType = 'arraybuffer'; // binary frames arrive as ArrayBuffer
    channel.bufferedAmountLowThreshold = LOW_WATER; // resume threshold for sends

    channel.onbufferedamountlow = () => {
      wakeDrain(peers.get(id)); // resume a backpressure-paused pump, if any
    };
    channel.onopen = () => {
      setPeerState(id, 'connected');
      flushPendingFiles(id); // send anything picked/dropped while connecting
    };
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') handleControlMessage(id, event.data);
      else handleFileChunk(id, event.data);
    };
    channel.onclose = () => {
      const entry = peers.get(id);
      wakeDrain(entry); // never leave a pump hanging on a dead channel
      failPeerTransfers(id, 'connection lost');
      setPeerState(id, 'disconnected');
    };
    channel.onerror = () => {
      const entry = peers.get(id);
      wakeDrain(entry);
      failPeerTransfers(id, 'connection lost');
      setPeerState(id, 'disconnected');
    };
  }

  function createPeerConnection(id, isOfferer) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry = { pc, channel: null, state: 'connecting', drainResolver: null };
    peers.set(id, entry);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(id, { kind: 'candidate', candidate: event.candidate });
      }
    };

    // Answerer side: the channel arrives via this event (offerer creates it).
    if (!isOfferer) {
      pc.ondatachannel = (event) => {
        entry.channel = event.channel;
        setupDataChannel(id, event.channel);
      };
    }

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') setPeerState(id, 'connected');
      else if (s === 'connecting' || s === 'new') setPeerState(id, 'connecting');
      else if (s === 'disconnected' || s === 'failed' || s === 'closed') {
        // Keep the entry so the card shows "Disconnected" and can be retried.
        setPeerState(id, 'disconnected');
      }
    };

    renderDevices();
    return entry;
  }

  // Open (or retry) a connection to one device. Duplicate-safe: no-ops while
  // a connection attempt is already in flight.
  async function connectToPeer(id) {
    // Avoid duplicate offers when already connecting/connected.
    const existing = peers.get(id);
    if (existing && existing.state !== 'disconnected') return;
    if (existing) {
      try {
        existing.pc.close();
      } catch {
        /* already closed */
      }
      peers.delete(id);
    }

    const entry = createPeerConnection(id, true);
    const channel = entry.pc.createDataChannel(CHANNEL_LABEL);
    entry.channel = channel;
    setupDataChannel(id, channel);

    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      sendSignal(id, { kind: 'offer', sdp: entry.pc.localDescription });
    } catch (err) {
      console.warn('[rtc] offer failed:', err);
      setPeerState(id, 'disconnected');
    }
  }

  // Incoming relayed signal from a peer: offer / answer / ICE candidate.
  async function handleSignal(from, data) {
    if (!data || typeof data.kind !== 'string') return;

    if (data.kind === 'offer') {
      // --- Glare: both sides tapped at once and both sent offers. ---
      // Resolve deterministically: the smaller id is "polite" and accepts
      // the incoming offer; the larger id ignores it and keeps its own.
      let entry = peers.get(from);
      const hasLocalOffer = !!entry && entry.pc.signalingState === 'have-local-offer';
      if (hasLocalOffer && !(myId < from)) return; // impolite: keep our offer
      if (!entry || entry.pc.signalingState === 'closed') {
        if (entry) {
          try {
            entry.pc.close();
          } catch {
            /* ignore */
          }
        }
        entry = createPeerConnection(from, false);
      }
      try {
        // Modern browsers implicitly roll back a local offer here (polite case).
        await entry.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        sendSignal(from, { kind: 'answer', sdp: entry.pc.localDescription });
      } catch (err) {
        console.warn('[rtc] answer failed:', err);
        setPeerState(from, 'disconnected');
      }
    } else if (data.kind === 'answer') {
      const entry = peers.get(from);
      if (!entry) return;
      try {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } catch (err) {
        console.warn('[rtc] bad answer:', err);
      }
    } else if (data.kind === 'candidate') {
      const entry = peers.get(from);
      if (!entry || !data.candidate) return;
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.warn('[rtc] bad ICE candidate:', err);
      }
    }
    // Unknown kinds are ignored.
  }

  // --- Sending files ---------------------------------------------------------------------
  fileInput.addEventListener('change', () => {
    const peerId = pickerPeerId;
    pickerPeerId = null;
    if (!peerId || !fileInput.files || fileInput.files.length === 0) return;
    const files = Array.from(fileInput.files);
    // Offline (still connecting): stash and send on channel open. The tap
    // already kicked off the connection, so this always resolves.
    if (openChannel(peers.get(peerId))) enqueueFiles(peerId, files);
    else {
      stashPendingFiles(peerId, files);
      connectToPeer(peerId);
    }
  });

  // Queue picked files behind any in-flight transfer to the same peer.
  function enqueueFiles(peerId, files) {
    if (!openChannel(peers.get(peerId))) {
      console.warn('[file] not connected, ignoring picked files');
      return;
    }
    let queue = sendQueues.get(peerId);
    if (!queue) {
      queue = [];
      sendQueues.set(peerId, queue);
    }
    for (const file of files) {
      const t = {
        id: crypto.randomUUID(),
        dir: 'up',
        peerId,
        file,
        name: file.name || 'file',
        size: file.size,
        mime: file.type || 'application/octet-stream',
        offset: 0,
        status: 'queued',
        startTime: null,
        endTime: null,
        cancelled: false,
        error: '',
        _els: null,
      };
      addTransfer(t);
      queue.push(t);
    }
    kickSendQueue(peerId);
  }

  // Start the next queued file if the peer has no active send. Strictly one
  // active send per peer, so binary frames never interleave between files.
  function kickSendQueue(peerId) {
    if (activeSendId.has(peerId)) return;
    const queue = sendQueues.get(peerId);
    if (!queue || queue.length === 0) return;
    if (!openChannel(peers.get(peerId))) {
      // Connection died while files waited: fail them all, keep states visible.
      for (const t of queue.splice(0)) {
        t.status = 'failed';
        t.error = 'connection lost';
      }
      renderTransfers();
      return;
    }
    const t = queue.shift();
    activeSendId.set(peerId, t.id);
    t.status = 'waiting';
    renderTransfers();
    sendControl(peerId, {
      type: 'file-offer',
      id: t.id,
      name: t.name,
      size: t.size,
      mime: t.mime,
    });
  }

  function releaseActiveSend(t) {
    if (activeSendId.get(t.peerId) === t.id) activeSendId.delete(t.peerId);
  }

  function failSend(t, error) {
    t.status = 'failed';
    t.error = error;
    t.endTime = Date.now();
    wakeDrain(peers.get(t.peerId));
    releaseActiveSend(t);
    renderTransfers();
    kickSendQueue(t.peerId);
  }

  // Pump 16 KiB chunks until the file is out, pausing on backpressure.
  async function pumpSend(t) {
    const entry = peers.get(t.peerId);
    const channel = entry && entry.channel;
    if (!openChannel(entry)) {
      failSend(t, 'connection lost');
      return;
    }
    try {
      while (t.offset < t.size) {
        if (t.cancelled) return; // cancelTransfer() already set the state
        if (channel.readyState !== 'open') {
          failSend(t, 'connection lost');
          return;
        }
        if (channel.bufferedAmount > HIGH_WATER) {
          // Pause: resumed by onbufferedamountlow, cancel, or channel close.
          await new Promise((resolve) => {
            entry.drainResolver = resolve;
          });
          continue; // re-check cancelled / closed before touching the channel
        }
        const end = Math.min(t.offset + CHUNK_SIZE, t.size);
        const buf = await t.file.slice(t.offset, end).arrayBuffer();
        if (t.cancelled) return;
        channel.send(buf);
        t.offset += buf.byteLength;
        updateTransferProgress(t);
      }
    } catch (err) {
      console.warn('[file] send failed:', err);
      failSend(t, 'send failed');
      return;
    }
    if (t.cancelled) return;
    sendControl(t.peerId, { type: 'file-end', id: t.id });
    t.status = 'done';
    t.endTime = Date.now();
    releaseActiveSend(t);
    renderTransfers();
    kickSendQueue(t.peerId);
  }

  // --- Receiving files ---------------------------------------------------------------------
  function activeReceiveFor(peerId) {
    // At most one: the sender only streams a single file per peer at a time.
    for (const t of transfersById.values()) {
      if (t.dir === 'down' && t.peerId === peerId && t.status === 'receiving') return t;
    }
    return null;
  }

  function appendChunk(t, buf) {
    if (t.status !== 'receiving') return; // late frame after cancel/done
    t.chunks.push(buf);
    t.received += buf.byteLength;
    if (t.received > t.size) {
      // Sender claims more bytes than offered: abort, don't build the Blob.
      t.status = 'failed';
      t.error = `size mismatch (got ${formatSize(t.received)}, expected ${formatSize(t.size)})`;
      t.endTime = Date.now();
      t.chunks = [];
      renderTransfers();
      return;
    }
    updateTransferProgress(t);
  }

  function handleFileChunk(peerId, data) {
    const t = activeReceiveFor(peerId);
    if (!t) return; // stray frame with no active download: ignore
    if (data instanceof Blob) {
      // binaryType is "arraybuffer" so this is just a safety net.
      data.arrayBuffer().then(
        (buf) => appendChunk(t, buf),
        () => {
          t.status = 'failed';
          t.error = 'unreadable chunk';
          t.endTime = Date.now();
          renderTransfers();
        }
      );
      return;
    }
    appendChunk(t, data);
  }

  function finalizeReceive(t) {
    if (t.received !== t.size) {
      t.status = 'failed';
      t.error = `size mismatch (got ${formatSize(t.received)}, expected ${formatSize(t.size)})`;
      t.endTime = Date.now();
      t.chunks = [];
      renderTransfers();
      return;
    }
    const blob = new Blob(t.chunks, { type: t.mime });
    t.chunks = []; // free the part list; the Blob holds the bytes now
    if (blob.size !== t.size) {
      t.status = 'failed';
      t.error = `size mismatch (got ${formatSize(blob.size)}, expected ${formatSize(t.size)})`;
      t.endTime = Date.now();
      renderTransfers();
      return;
    }
    t.blob = blob;
    t.objectUrl = URL.createObjectURL(blob);
    t.status = 'done';
    t.endTime = Date.now();
    renderTransfers();
  }

  // --- Control messages (both directions) ------------------------------------------------------
  function handleControlMessage(peerId, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // not a control message: ignore
    }
    if (!msg || typeof msg.type !== 'string' || typeof msg.id !== 'string') return;

    if (msg.type === 'file-offer') {
      // Validate the offer shape before showing anything.
      if (
        transfersById.has(msg.id) ||
        typeof msg.name !== 'string' ||
        typeof msg.size !== 'number' ||
        !isFinite(msg.size) ||
        msg.size < 0 ||
        (msg.mime !== undefined && typeof msg.mime !== 'string')
      ) {
        return;
      }
      addTransfer({
        id: msg.id,
        dir: 'down',
        peerId,
        name: sanitizeFileName(msg.name),
        size: Math.floor(msg.size),
        mime: msg.mime || 'application/octet-stream',
        chunks: [],
        received: 0,
        status: 'incoming',
        startTime: null,
        endTime: null,
        objectUrl: null,
        error: '',
        _els: null,
      });
      return;
    }

    // Every other control message refers to a known transfer of this peer.
    const t = transfersById.get(msg.id);
    if (!t || t.peerId !== peerId) return;

    if (msg.type === 'file-accept') {
      if (t.dir === 'up' && t.status === 'waiting') {
        t.status = 'sending';
        t.startTime = Date.now();
        renderTransfers();
        pumpSend(t); // async loop; settles the transfer and kicks the queue
      }
    } else if (msg.type === 'file-decline') {
      if (t.dir === 'up' && t.status === 'waiting') {
        t.status = 'declined';
        t.endTime = Date.now();
        releaseActiveSend(t);
        renderTransfers();
        kickSendQueue(t.peerId);
      }
    } else if (msg.type === 'file-end') {
      if (t.dir === 'down' && t.status === 'receiving') finalizeReceive(t);
    } else if (msg.type === 'file-cancel') {
      if (t.dir === 'up' && (t.status === 'waiting' || t.status === 'sending')) {
        // Peer aborted our send: stop the pump and move to the next file.
        t.cancelled = true;
        t.status = 'cancelled';
        t.endTime = Date.now();
        wakeDrain(peers.get(t.peerId));
        releaseActiveSend(t);
        renderTransfers();
        kickSendQueue(t.peerId);
      } else if (t.dir === 'down' && (t.status === 'incoming' || t.status === 'receiving')) {
        t.status = 'cancelled';
        t.endTime = Date.now();
        t.chunks = [];
        renderTransfers();
      }
    }
    // Unknown control types are ignored.
  }

  // --- Transfer buttons ------------------------------------------------------------------
  function acceptTransfer(id) {
    const t = transfersById.get(id);
    if (!t || t.dir !== 'down' || t.status !== 'incoming') return;
    if (!sendControl(t.peerId, { type: 'file-accept', id })) {
      t.status = 'failed';
      t.error = 'connection lost';
      t.endTime = Date.now();
      renderTransfers();
      return;
    }
    t.status = 'receiving';
    t.startTime = Date.now();
    renderTransfers();
  }

  function declineTransfer(id) {
    const t = transfersById.get(id);
    if (!t || t.dir !== 'down' || t.status !== 'incoming') return;
    sendControl(t.peerId, { type: 'file-decline', id });
    t.status = 'declined';
    t.endTime = Date.now();
    renderTransfers();
  }

  // Cancel button: works on our sends (waiting/sending) and our downloads
  // (receiving). Notifies the peer so both sides settle on "Cancelled".
  function cancelTransfer(id) {
    const t = transfersById.get(id);
    if (!t) return;
    if (t.dir === 'up' && (t.status === 'waiting' || t.status === 'sending')) {
      sendControl(t.peerId, { type: 'file-cancel', id });
      t.cancelled = true; // stops the pump between chunks / wakes the drain wait
      t.status = 'cancelled';
      t.endTime = Date.now();
      wakeDrain(peers.get(t.peerId));
      releaseActiveSend(t);
      renderTransfers();
      kickSendQueue(t.peerId);
    } else if (t.dir === 'down' && t.status === 'receiving') {
      sendControl(t.peerId, { type: 'file-cancel', id });
      t.status = 'cancelled';
      t.endTime = Date.now();
      t.chunks = [];
      renderTransfers();
    }
  }

  // --- Transfer cleanup ----------------------------------------------------------------
  function isActiveTransfer(t) {
    return (
      t.status === 'queued' ||
      t.status === 'waiting' ||
      t.status === 'sending' ||
      t.status === 'incoming' ||
      t.status === 'receiving'
    );
  }

  function hasActiveTransfer() {
    for (const t of transfersById.values()) {
      if (isActiveTransfer(t)) return true;
    }
    return false;
  }

  // Mark every unsettled transfer with a peer as failed (device left / down).
  // Finished transfers (done/declined/cancelled/failed) keep their state.
  function failPeerTransfers(peerId, error) {
    let changed = false;
    for (const t of transfersById.values()) {
      if (t.peerId !== peerId || !isActiveTransfer(t)) continue;
      t.status = 'failed';
      t.error = error;
      t.endTime = Date.now();
      t.cancelled = true;
      if (t.dir === 'down') t.chunks = [];
      changed = true;
    }
    if (activeSendId.has(peerId)) activeSendId.delete(peerId);
    if (sendQueues.has(peerId)) sendQueues.delete(peerId);
    if (pendingFiles.has(peerId)) pendingFiles.delete(peerId);
    wakeDrain(peers.get(peerId));
    if (changed) renderTransfers();
  }

  // Our lobby socket dropped: peer connections are dead, so fail everything.
  function failAllTransfers(error) {
    let changed = false;
    for (const t of transfersById.values()) {
      if (!isActiveTransfer(t)) continue;
      t.status = 'failed';
      t.error = error;
      t.endTime = Date.now();
      t.cancelled = true;
      if (t.dir === 'down') t.chunks = [];
      changed = true;
    }
    activeSendId.clear();
    sendQueues.clear();
    pendingFiles.clear();
    for (const [, entry] of peers) wakeDrain(entry);
    if (changed) renderTransfers();
  }

  // Leaving / reloading mid-transfer would strand the peer and lose bytes,
  // so warn first. Idle users (and finished transfers) get no prompt.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', (event) => {
      if (!hasActiveTransfer()) return;
      event.preventDefault(); // Chrome requires preventDefault…
      event.returnValue = ''; // …plus returnValue to trigger the prompt.
    });
  }

  // --- Peer cleanup ----------------------------------------------------------------
  // Device left the room: tear down its connection so nothing leaks.
  function removeGonePeers() {
    const present = new Set(devices.map((d) => d.id));
    for (const [id, entry] of peers) {
      if (!present.has(id)) {
        failPeerTransfers(id, 'device left');
        try {
          entry.pc.close();
        } catch {
          /* ignore */
        }
        peers.delete(id);
      }
    }
  }

  // Our own socket dropped (or we got a new identity): all peer connections
  // are tied to the old session, so close everything.
  function closeAllPeers() {
    failAllTransfers('connection lost');
    for (const [, entry] of peers) {
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
    }
    peers.clear();
  }

  // --- Page-level drag & drop ----------------------------------------------------------
  // Dragging files over the page raises a full-page overlay. Dropping on a
  // device card is handled by the card itself; dropping anywhere else routes
  // here: one nearby device → send straight to it, several → pick one from a
  // short list, none → a transient "No devices nearby" note.
  let dragDepth = 0; // dragenter/dragleave nesting counter (children re-fire)
  let overlayMode = null; // null (hidden) | 'hover' | 'picker' | 'notice'
  let overlayFiles = []; // files from the drop that opened the picker
  let noticeTimer = 0;

  function dragHasFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  function hideOverlay() {
    dragDepth = 0;
    overlayMode = null;
    overlayFiles = [];
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = 0;
    }
    if (dropOverlay) dropOverlay.hidden = true;
  }

  function showHoverOverlay() {
    overlayMode = 'hover';
    dropMessage.textContent = 'Drop files to send';
    dropPicker.innerHTML = '';
    dropOverlay.hidden = false;
  }

  function showNotice(text) {
    overlayMode = 'notice';
    dropMessage.textContent = text;
    dropPicker.innerHTML = '';
    dropOverlay.hidden = false;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideOverlay, 2500); // transient: gone on its own
  }

  // Several devices nearby: let the user pick the recipient (real buttons,
  // textContent names — same XSS rule as the device list).
  function showDevicePicker(files) {
    overlayMode = 'picker';
    overlayFiles = files;
    dropMessage.textContent = 'Choose a device';
    dropPicker.innerHTML = '';
    for (const device of devices) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = device.name;
      btn.setAttribute('aria-label', `Send files to ${device.name}`);
      btn.addEventListener('click', () => {
        const pending = overlayFiles;
        hideOverlay();
        dropFiles(device.id, pending);
      });
      li.appendChild(btn);
      dropPicker.appendChild(li);
    }
    dropOverlay.hidden = false;
  }

  function handleElsewhereDrop(files) {
    if (files.length === 0) {
      hideOverlay();
      return;
    }
    if (devices.length === 0) showNotice('No devices nearby');
    else if (devices.length === 1) {
      hideOverlay();
      dropFiles(devices[0].id, files);
    } else showDevicePicker(files);
  }

  if (typeof window !== 'undefined' && window.addEventListener && dropOverlay) {
    window.addEventListener('dragenter', (event) => {
      if (!dragHasFiles(event)) return; // ignore text/link drags
      event.preventDefault();
      dragDepth++;
      if (overlayMode === null) showHoverOverlay();
    });
    window.addEventListener('dragover', (event) => {
      if (dragHasFiles(event)) event.preventDefault(); // required to receive drop
    });
    window.addEventListener('dragleave', (event) => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      // Only hover mode tracks the drag: picker/notice stay until resolved.
      if (overlayMode !== 'hover') return;
      if (dragDepth > 0) dragDepth--;
      if (dragDepth === 0) hideOverlay();
    });
    window.addEventListener('drop', (event) => {
      event.preventDefault(); // card drops stopPropagation and never reach here
      dragDepth = 0;
      const files = event.dataTransfer && event.dataTransfer.files;
      handleElsewhereDrop(files ? Array.from(files) : []);
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && overlayMode !== null) hideOverlay();
    });
    dropCancel.addEventListener('click', hideOverlay);
  }

  // --- WebSocket lobby ---------------------------------------------------------
  function connect() {
    // Use wss:// on HTTPS pages, ws:// otherwise. Same host/port as the page.
    // Our UA rides along as `?ua=` so peers can show a matching device icon,
    // and our saved device name as `?name=` so the room keeps calling us that.
    sentName = loadSavedName();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let url = `${protocol}//${location.host}/ws?ua=${encodeURIComponent(MY_UA)}`;
    if (sentName) url += `&name=${encodeURIComponent(sentName)}`;
    ws = new WebSocket(url);

    setStatus(false, 'Connecting to the lobby…');

    ws.onopen = () => {
      retryMs = 1000; // reset backoff after a successful (re)connect
      setStatus(true, 'Connected. Waiting for identity…');
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // ignore malformed payloads
      }

      if (msg.type === 'hello') {
        myId = msg.you.id;
        myName = msg.you.name;
        youEl.textContent = myName;
        // First join (nothing saved yet): persist the assigned name. If we
        // offered a saved name but got a temp one (taken by another tab in
        // this browser, which shares localStorage), keep the saved one —
        // never overwrite it with the session-scoped name.
        if (!sentName) saveDeviceName(myName);
        reconnectBanner.hidden = true; // back online: hide the banner
        closeAllPeers(); // stale sessions from a previous socket are dead
        renderDevices();
        setStatus(true, 'Connected. Tap a device to send it files.');
      } else if (msg.type === 'devices') {
        const all = msg.devices || [];
        for (const d of all) {
          nameById.set(d.id, d.name);
          uaById.set(d.id, d.ua || '');
        }
        devices = all.filter((d) => d.id !== myId);
        removeGonePeers(); // cleanly drop connections to departed devices
        renderDevices();
      } else if (msg.type === 'signal') {
        if (typeof msg.from === 'string' && 'data' in msg) {
          handleSignal(msg.from, msg.data);
        }
      }
      // Unknown types are ignored.
    };

    ws.onclose = () => {
      setStatus(false, 'Disconnected. Reconnecting…');
      reconnectBanner.hidden = false; // visible banner until hello arrives
      youEl.textContent = 'Connecting…';
      closeAllPeers();
      renderDevices();
      // Simple reconnect with capped exponential backoff.
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 10000);
    };

    ws.onerror = () => ws.close(); // let onclose handle the retry
  }

  connect();
})();
