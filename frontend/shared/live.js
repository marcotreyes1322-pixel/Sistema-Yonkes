// Shared helpers for both PWAs: resilient WebSocket client, DOM builder,
// alerts (sound / vibration / notifications) and service-worker registration.

/**
 * WebSocket client that authenticates, keeps itself alive and reconnects.
 *
 * - Sends {"type":"auth"} as the first frame (token never goes in the URL).
 * - Heartbeat: ping every 25 s; if nothing arrives for 60 s the socket is
 *   considered dead (typical on phones switching wifi <-> data) and replaced.
 * - Reconnects with exponential backoff + jitter, and immediately when the
 *   device comes back online or the app returns to the foreground.
 * - Close 4001 (bad token) stops retrying; 4003 (no subscription) retries slowly.
 */
export class LiveSocket {
  constructor({ path, getToken, onMessage, onStatus, onDenied }) {
    this.path = path;
    this.getToken = getToken;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.onDenied = onDenied || (() => {});
    this.ws = null;
    this.ready = false;
    this.stopped = true;
    this.attempt = 0;
    this.retryTimer = null;
    this.heartbeat = null;
    this.connectTimer = null;
    this.lastSeen = 0;
    this.pending = new Map(); // ref -> {resolve, reject, timer}
    this.refSeq = 0;

    const wake = () => {
      if (!this.stopped && !this.ready && document.visibilityState === "visible") this.reconnectNow();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", () => {
      wake();
      // Coming back to the foreground: verify the socket is really alive.
      if (this.ready && document.visibilityState === "visible") this._send({ type: "ping" });
    });
  }

  start() {
    this.stopped = false;
    this.attempt = 0;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this._teardown();
    this.onStatus("offline");
  }

  reconnectNow() {
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    this._connect();
  }

  /** Send a message and wait for the server reply carrying the same ref. */
  request(type, payload = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.ready) return reject(new Error("Sin conexión con el servidor"));
      const ref = `r${++this.refSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        reject(new Error("El servidor no respondió, intenta de nuevo"));
      }, timeoutMs);
      this.pending.set(ref, { resolve, reject, timer });
      this._send({ type, ref, ...payload });
    });
  }

  // --- internals ---------------------------------------------------------

  _connect() {
    this._teardown();
    const token = this.getToken();
    if (!token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${this.path}`);
    this.ws = ws;
    this.onStatus("connecting");
    // Some networks leave a socket hanging without ever failing: give up and retry.
    this.connectTimer = setTimeout(() => this.ws === ws && !this.ready && ws.close(), 15000);

    ws.onopen = () => {
      this.lastSeen = Date.now();
      ws.send(JSON.stringify({ type: "auth", token }));
    };

    ws.onmessage = (ev) => {
      this.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "hello") {
        clearTimeout(this.connectTimer);
        this.ready = true;
        this.attempt = 0;
        this._startHeartbeat();
        this.onStatus("online");
      }
      if (msg.ref && this.pending.has(msg.ref)) {
        const p = this.pending.get(msg.ref);
        this.pending.delete(msg.ref);
        clearTimeout(p.timer);
        msg.type === "error" ? p.reject(new Error(msg.message)) : p.resolve(msg);
      }
      if (msg.type !== "pong") this.onMessage(msg);
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // an old socket we already replaced
      this._teardown();
      if (this.stopped) return;
      if (ev.code === 4001) {
        this.stopped = true;
        this.onStatus("denied");
        this.onDenied("token");
        return;
      }
      if (ev.code === 4003) {
        this.onStatus("denied");
        this.onDenied("subscription");
        this.retryTimer = setTimeout(() => this._connect(), 60000);
        return;
      }
      this.onStatus(navigator.onLine ? "reconnecting" : "offline");
      const delay = Math.min(30000, 1000 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
      this.retryTimer = setTimeout(() => this._connect(), delay);
    };
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _startHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > 60000) {
        this.ws && this.ws.close(); // half-open socket: force a reconnect
        return;
      }
      this._send({ type: "ping" });
    }, 25000);
  }

  _teardown() {
    this.ready = false;
    clearInterval(this.heartbeat);
    clearTimeout(this.connectTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Se perdió la conexión, intenta de nuevo"));
    }
    this.pending.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = ws.onmessage = ws.onclose = null;
      if (ws.readyState <= WebSocket.OPEN) ws.close();
    }
  }
}

/** Tiny DOM builder: h("div#id.card", {onclick}, "text", child). Text is never parsed as HTML. */
export function h(tag, attrs, ...children) {
  const [, name, id, classes] = tag.match(/^([\w-]*)(?:#([\w-]+))?((?:\.[\w-]+)*)$/);
  const el = document.createElement(name || "div");
  if (id) el.id = id;
  if (classes) el.className = classes.slice(1).replaceAll(".", " ");
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && k !== "list" && k !== "form") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export const money = (n) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 }).format(n);

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "hace un momento";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

export function formatDate(isoDate) {
  // "2026-10-25" is a calendar date; parse as local, not UTC midnight.
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
}

/** Days from today (local) until a YYYY-MM-DD date; negative if past. */
export function daysUntil(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d) - today) / 86400000);
}

export const CONDITIONS = { good: "Bueno", regular: "Regular", bad: "Malo" };

export const STATUS_TEXT = {
  connecting: "Conectando…",
  online: "En línea",
  reconnecting: "Reconectando…",
  offline: "Sin conexión",
  denied: "Sin acceso",
};

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    return null;
  }
}

// --- alerts -----------------------------------------------------------------

let audioCtx = null;

/** Must be called from a user gesture (tap) so browsers allow sound later. */
export async function enableAlerts() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
  } catch {}
  if ("Notification" in window && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {}
  }
  return alertsEnabled();
}

export const alertsEnabled = () => !!audioCtx && audioCtx.state === "running";

export function beep(times = 2) {
  if (!audioCtx || audioCtx.state !== "running") return;
  for (let i = 0; i < times; i++) {
    const t = audioCtx.currentTime + i * 0.25;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = i % 2 ? 660 : 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.21);
  }
}

export async function notify(title, body, { tag, icon = "/shared/icons/recepcion-192.png" } = {}) {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (document.visibilityState === "visible") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body, tag, renotify: !!tag, icon };
    reg ? await reg.showNotification(title, opts) : new Notification(title, opts);
  } catch {}
}

// --- PWA --------------------------------------------------------------------

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW:", e));
  });
}

/** Wires an "Instalar" button to the browser's install prompt (Chrome/Edge/Android). */
export function setupInstallButton(button) {
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    button.hidden = false;
  });
  button.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    button.hidden = true;
  });
  window.addEventListener("appinstalled", () => (button.hidden = true));
}

export function toast(text, kind = "") {
  let box = document.getElementById("toasts");
  if (!box) document.body.append((box = h("div#toasts")));
  const el = h(`div.toast${kind ? "." + kind : ""}`, { role: "status" }, text);
  box.append(el);
  setTimeout(() => el.classList.add("out"), 3500);
  setTimeout(() => el.remove(), 4000);
}
