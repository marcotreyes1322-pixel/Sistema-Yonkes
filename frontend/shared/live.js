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

// --- icons ------------------------------------------------------------------

// Line icons (Lucide, ISC license), 24x24 viewBox, drawn with currentColor.
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  camera:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  phone:
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  wrench:
    '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  inbox:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  pause: '<rect width="4" height="16" x="6" y="4" rx="1"/><rect width="4" height="16" x="14" y="4" rx="1"/>',
  play: '<path d="m6 3 14 9-14 9V3z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
};

/** Inline SVG icon. Markup comes only from the constant table above. */
export function icon(name, size = 18) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.9",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "icon",
  }))
    svg.setAttribute(k, v);
  svg.innerHTML = ICONS[name] || "";
  return svg;
}

// --- photos -----------------------------------------------------------------

/** Downscale on the phone before uploading: a 4 MB camera shot becomes ~150-300 KB. */
export async function compressImage(file, maxSide = 1440, quality = 0.8) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("No pudimos leer esa imagen"));
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("No pudimos procesar esa imagen");
  return blob;
}

export async function uploadPhoto(file, token) {
  const body = await compressImage(file);
  const res = await fetch("/api/photos", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/jpeg" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "No se pudo subir la foto");
  return data; // {id, url}
}

/**
 * "Add photo" control. Uploads as soon as a picture is chosen (camera or gallery).
 * value(): undefined while untouched, the new photo id, or null if removed.
 */
export function photoField({ getToken, url = null, label = "Agregar foto" }) {
  let current = url;
  let value; // undefined = unchanged
  let uploading = null;
  const input = h("input", { type: "file", accept: "image/*", hidden: true });
  const el = h("div.photo-field");

  const render = (preview = current, busy = false) => {
    el.replaceChildren(
      input,
      preview
        ? h(
            "div.photo-preview",
            h("button.thumb", { type: "button", onclick: () => !busy && openPhoto(preview), "aria-label": "Ver foto" }, h("img", { src: preview, alt: "" })),
            busy && h("div.photo-busy", h("span.spinner")),
            !busy &&
              h(
                "button.icon-btn.photo-remove",
                {
                  type: "button",
                  "aria-label": "Quitar foto",
                  onclick: () => {
                    current = null;
                    value = null;
                    render();
                  },
                },
                icon("x", 16),
              ),
          )
        : h("button.photo-add", { type: "button", onclick: () => input.click() }, icon("camera", 20), h("span", label)),
    );
  };

  input.addEventListener("change", () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    const preview = URL.createObjectURL(file);
    render(preview, true);
    uploading = uploadPhoto(file, getToken())
      .then((photo) => {
        current = photo.url;
        value = photo.id;
        render();
      })
      .catch((err) => {
        toast(err.message, "error");
        render();
      })
      .finally(() => (uploading = null));
  });

  render();
  return { el, value: () => value, ready: () => uploading || Promise.resolve() };
}

/** Full-screen viewer; tap anywhere or press Esc to close. */
export function openPhoto(url) {
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  const overlay = h(
    "div.lightbox",
    { role: "dialog", "aria-label": "Foto", onclick: close },
    h("img", { src: url, alt: "" }),
    h("button.icon-btn.lightbox-close", { type: "button", "aria-label": "Cerrar" }, icon("x", 22)),
  );
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
}

/** Small clickable thumbnail for a photo URL (or nothing). */
export const thumb = (url, cls = "") =>
  url && h(`button.thumb${cls}`, { type: "button", onclick: () => openPhoto(url), "aria-label": "Ver foto" }, h("img", { src: url, alt: "", loading: "lazy" }));

/** Fill every [data-icon] placeholder in static HTML with its SVG. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    const size = el.classList.contains("brand-mark") ? 18 : el.classList.contains("empty-icon") ? 26 : 18;
    el.replaceChildren(icon(el.dataset.icon, size));
  }
}

/** Banner content: icon + text (text is never parsed as HTML). */
export function setBanner(el, iconName, text) {
  el.replaceChildren(icon(iconName), h("span.grow", text));
  el.hidden = !text;
}
