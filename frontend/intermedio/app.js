// Broker panel: broadcasts part requests, collects quotes live and manages
// yonke subscriptions / access codes.
import {
  CONDITIONS,
  LiveSocket,
  STATUS_TEXT,
  beep,
  daysUntil,
  enableAlerts,
  formatDate,
  h,
  hydrateIcons,
  icon,
  money,
  notify,
  photoField,
  registerServiceWorker,
  setupInstallButton,
  store,
  thumb,
  timeAgo,
  toast,
} from "/shared/live.js";

const TOKEN_KEY = "broker.token";
const $ = (id) => document.getElementById(id);

const state = {
  requests: new Map(), // id -> request with quotes[]
  yonkes: new Map(), // id -> yonke
  online: new Set(),
  showClosed: false,
};

hydrateIcons();

// --- connection & auth ------------------------------------------------------

const socket = new LiveSocket({
  path: "/ws/broker",
  getToken: () => store(TOKEN_KEY),
  onMessage: handleMessage,
  onStatus: (s) => {
    $("status").dataset.state = s;
    $("status").textContent = STATUS_TEXT[s];
  },
  onDenied: () => logout("La contraseña ya no es válida. Vuelve a entrar."),
});

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${store(TOKEN_KEY)}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    logout("La contraseña ya no es válida. Vuelve a entrar.");
    throw new Error("Contraseña incorrecta");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.detail) ? "Revisa los datos del formulario" : data.detail;
    throw new Error(detail || `Error ${res.status}`);
  }
  return data;
}

function logout(error = "") {
  socket.stop();
  store(TOKEN_KEY, null);
  $("panel").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = error;
  $("login-error").hidden = !error;
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("token").value.trim();
  const button = e.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  enableAlerts();
  // Check the password right away instead of failing later on the first action.
  try {
    const res = await fetch("/api/yonkes", { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      $("login-error").textContent = "Contraseña incorrecta. Revisa mayúsculas y minúsculas (toca «Ver» para revisarla).";
      $("login-error").hidden = false;
      return;
    }
  } catch {
    // Offline or server waking up: let the live connection keep retrying.
  } finally {
    button.disabled = false;
  }
  store(TOKEN_KEY, token);
  $("token").value = "";
  start();
});

$("toggle-token").addEventListener("click", () => {
  const input = $("token");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggle-token").textContent = show ? "Ocultar" : "Ver";
  $("toggle-token").setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña");
});

function start() {
  $("login").hidden = true;
  $("panel").hidden = false;
  socket.start();
}

document.addEventListener("pointerdown", () => enableAlerts(), { once: true });

// --- tabs -------------------------------------------------------------------

function selectTab(name) {
  for (const t of ["requests", "yonkes"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`view-${t}`).hidden = t !== name;
  }
  store("broker.tab", name);
}
$("tab-requests").onclick = () => selectTab("requests");
$("tab-yonkes").onclick = () => selectTab("yonkes");
selectTab(store("broker.tab") === "yonkes" ? "yonkes" : "requests");

// --- server messages --------------------------------------------------------

function handleMessage(msg) {
  switch (msg.type) {
    case "hello":
      state.requests = new Map(msg.requests.map((r) => [r.id, r]));
      state.yonkes = new Map(msg.yonkes.map((y) => [y.id, y]));
      state.online = new Set(msg.online);
      renderRequests();
      renderYonkes();
      break;

    case "request.created":
      state.requests.set(msg.request.id, msg.request);
      renderRequests();
      break;

    case "request.updated": {
      const req = state.requests.get(msg.request.id);
      state.requests.set(msg.request.id, { ...req, ...msg.request, quotes: req?.quotes || [] });
      renderRequests();
      break;
    }

    case "quote.new":
    case "quote.updated": {
      const q = msg.quote;
      const req = state.requests.get(q.request_id);
      if (!req) break;
      req.quotes = [...req.quotes.filter((x) => x.id !== q.id), q].sort((a, b) => a.price - b.price);
      renderRequests();
      beep(msg.type === "quote.new" ? 2 : 1);
      notify(`${money(q.price)} · ${q.yonke.name}`, `${req.part_name} · ${req.vehicle_model}`, {
        tag: `quote-${q.id}`,
        icon: "/shared/icons/intermedio-192.png",
      });
      break;
    }

    case "presence":
      state.online = new Set(msg.online);
      renderOnline();
      renderRequests();
      renderYonkes();
      break;

    case "yonke.updated":
      state.yonkes.set(msg.yonke.id, msg.yonke);
      renderYonkes();
      break;
  }
}

function renderOnline() {
  const n = state.online.size;
  $("online-count").textContent = `${n} yonke${n === 1 ? "" : "s"} en línea`;
  const open = [...state.requests.values()].filter((r) => r.status === "open").length;
  $("count-requests").textContent = open ? String(open) : "";
  $("count-yonkes").textContent = state.yonkes.size ? String(state.yonkes.size) : "";
}

// --- requests ---------------------------------------------------------------

let requestPhoto;
function resetRequestPhoto() {
  requestPhoto = photoField({ getToken: () => store(TOKEN_KEY), label: "Agregar foto" });
  $("request-photo").replaceChildren(requestPhoto.el);
}
resetRequestPhoto();

$("request-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await requestPhoto.ready();
    const reply = await socket.request("request.create", {
      part_name: form.elements.part_name.value.trim(),
      vehicle_model: form.elements.vehicle_model.value.trim(),
      photo_id: requestPhoto.value() || null,
    });
    const n = reply.delivered_to;
    toast(n ? `Enviada a ${n} yonke${n === 1 ? "" : "s"} en línea` : "Guardada, pero no hay yonkes en línea ahora", n ? "ok" : "");
    form.reset();
    resetRequestPhoto();
    form.elements.part_name.focus();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("show-closed").addEventListener("change", (e) => {
  state.showClosed = e.target.checked;
  renderRequests();
});

function renderRequests() {
  renderOnline();
  const list = [...state.requests.values()]
    .filter((r) => state.showClosed || r.status === "open" || recentlyFound(r))
    .sort((a, b) => (a.status === b.status ? b.timestamp.localeCompare(a.timestamp) : a.status === "open" ? -1 : 1));
  $("requests").replaceChildren(...list.map(requestCard));
  $("requests-empty").hidden = list.length > 0;
}

// Found parts stay on the main list for a day so the broker can follow up with the winner.
const recentlyFound = (r) => r.selected_quote_id != null && Date.now() - new Date(r.timestamp) < 86400000;

const conditionBadge = (c) => h(`span.badge.${c === "good" ? "ok" : c === "regular" ? "warn" : "danger"}`, CONDITIONS[c]);

function requestCard(r) {
  const open = r.status === "open";
  const found = r.selected_quote_id != null;
  // Winner first, then by price.
  const quotes = [...(r.quotes || [])].sort((a, b) => (b.id === r.selected_quote_id) - (a.id === r.selected_quote_id));
  const n = quotes.length;
  return h(
    "article.card.req",
    { style: open || found ? null : "opacity: .7" },
    h(
      "header.req-head",
      h(
        "div.req-main",
        h(
          "div.req-top",
          open
            ? h("span.badge.accent", "Abierta")
            : found
              ? h("span.badge.ok", icon("check", 12), "Conseguida")
              : h("span.badge", "Cerrada"),
          n > 0 && h("span.badge", `${n} cotizaci${n === 1 ? "ón" : "ones"}`),
        ),
        h("h3.req-title", r.part_name),
        h(
          "div.req-meta",
          h("span.meta", icon("car", 16), r.vehicle_model),
          h("span.meta", icon("clock", 15), h("span", { dataset: { ts: r.timestamp } }, timeAgo(r.timestamp))),
        ),
      ),
      thumb(r.photo_url),
    ),
    n
      ? h("div.quotes", quotes.map((q, i) => quoteRow(r, q, open && n > 1 && i === 0)))
      : h(
          "div.waiting",
          icon("clock", 16),
          open
            ? `Esperando cotizaciones · ${state.online.size} yonke${state.online.size === 1 ? "" : "s"} en línea`
            : "Se cerró sin cotizaciones.",
        ),
    open &&
      h(
        "div.req-foot",
        h(
          "button.ghost.sm",
          {
            onclick: async () => {
              const q = `¿Cerrar "${r.part_name}" sin elegir cotización?\n\nA los yonkes les aparecerá, con un mensaje amable, que la solicitud ya quedó cubierta.`;
              if (!confirm(q)) return;
              try {
                await api("POST", `/api/requests/${r.id}/close`);
              } catch (err) {
                toast(err.message, "error");
              }
            },
          },
          "Cerrar sin elegir",
        ),
      ),
  );
}

function quoteRow(r, q, best) {
  const selected = q.id === r.selected_quote_id;
  const wa = whatsappUrl(
    q.yonke.phone,
    selected
      ? `Hola ${q.yonke.name}, ¡buenas noticias! Nos quedamos con tu ${r.part_name} para ${r.vehicle_model} en ${money(q.price)}. ¿Nos la apartas, por favor? En un momento te confirmo cuándo pasamos por ella. ¡Gracias!`
      : `Hola ${q.yonke.name}, te escribo por tu cotización de ${r.part_name} (${r.vehicle_model}) en ${money(q.price)}. `,
  );
  const dimmed = r.selected_quote_id != null && !selected;
  return h(
    `div.quote${best ? ".best" : ""}${selected ? ".selected" : ""}${dimmed ? ".dimmed" : ""}`,
    thumb(q.photo_url),
    h(
      "div.quote-main",
      h(
        "div.quote-name",
        q.yonke.name,
        conditionBadge(q.condition),
        best && h("span.badge.ok", "Mejor precio"),
        selected && h("span.badge.solid", icon("check", 12), "Elegida"),
      ),
      q.notes && h("div.quote-notes", q.notes),
      h(
        "div.quote-links",
        h("a", { href: `tel:${q.yonke.phone}` }, icon("phone", 14), q.yonke.phone),
        h("a", { href: wa, target: "_blank", rel: "noopener" }, icon("message", 14), "WhatsApp"),
        h("span.meta", { style: "font-size: inherit" }, h("span", { dataset: { ts: q.created_at } }, timeAgo(q.created_at))),
      ),
    ),
    h(
      "div.quote-side",
      h("div.price", money(q.price)),
      r.status === "open" && h("button.sm", { type: "button", onclick: () => selectQuote(r, q) }, "Elegir esta"),
      selected && h("a.btn.sm.success", { href: wa, target: "_blank", rel: "noopener" }, icon("message", 15), "Pedirle que la aparte"),
    ),
  );
}

async function selectQuote(r, q) {
  const question =
    `¿Elegir la pieza de ${q.yonke.name} por ${money(q.price)}?\n\n` +
    `La solicitud se cierra. A ${q.yonke.name} le pediremos que aparte la pieza, y a los demás yonkes les avisaremos de forma discreta que la solicitud ya quedó cubierta (no sabrán a quién se eligió).`;
  if (!confirm(question)) return;
  try {
    const updated = await api("POST", `/api/requests/${r.id}/select`, { quote_id: q.id });
    const req = state.requests.get(r.id);
    state.requests.set(r.id, { ...req, ...updated, quotes: req?.quotes || [] });
    renderRequests();
    toast(`Listo: elegiste a ${q.yonke.name}. Toca «Pedirle que la aparte» para escribirle por WhatsApp.`, "ok");
  } catch (err) {
    toast(err.message, "error");
  }
}

function whatsappUrl(phone, text) {
  let digits = phone.replace(/\D/g, "");
  if (digits.length === 10) digits = `52${digits}`; // Mexican local number
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// --- yonkes -----------------------------------------------------------------

$("yonke-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const cred = await api("POST", "/api/yonkes", {
      name: form.elements.name.value.trim(),
      phone: form.elements.phone.value.trim(),
      months: Number(form.elements.months.value),
    });
    state.yonkes.set(cred.yonke.id, cred.yonke);
    renderYonkes();
    form.reset();
    showCredentials(cred, `${cred.yonke.name} registrado`);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    button.disabled = false;
  }
});

function subscriptionBadge(y) {
  if (y.subscription_status === "suspended") return h("span.badge.danger", "Suspendido");
  const days = daysUntil(y.payment_due_date);
  if (days < 0) return h("span.badge.danger", "Vencido");
  if (days <= 5) return h("span.badge.warn", days === 0 ? "Vence hoy" : `Vence en ${days} d`);
  return h("span.badge.ok", "Activo");
}

const initials = (name) =>
  name
    .split(/\s+/)
    .filter((w) => w.length > 2 || /^[A-ZÁÉÍÓÚÑ]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || name.slice(0, 1).toUpperCase();

function renderYonkes() {
  renderOnline();
  const yonkes = [...state.yonkes.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
  $("yonkes").replaceChildren(
    ...yonkes.map((y) => {
      const online = state.online.has(y.id);
      const suspended = y.subscription_status === "suspended";
      return h(
        "div.yonke-row",
        h(`div.avatar${online ? ".on" : ""}`, { title: online ? "En línea" : "Desconectado" }, initials(y.name)),
        h(
          "div.grow",
          h("div.quote-name", y.name, subscriptionBadge(y)),
          h(
            "div.quote-links",
            h("a", { href: `tel:${y.phone}` }, icon("phone", 14), y.phone),
            h("span.meta", { style: "font-size: inherit" }, icon("clock", 14), `Pagado hasta el ${formatDate(y.payment_due_date)}`),
          ),
        ),
        h(
          "div.yonke-actions",
          h("button.sm", { onclick: () => registerPayment(y) }, icon("plus", 15), "1 mes"),
          h(
            "button.secondary.sm",
            { onclick: () => setSuspended(y, !suspended) },
            icon(suspended ? "play" : "pause", 14),
            suspended ? "Reactivar" : "Suspender",
          ),
          h("button.secondary.sm", { onclick: () => regenerateToken(y) }, icon("key", 15), "Nuevo código"),
        ),
      );
    }),
  );
  $("yonkes").hidden = yonkes.length === 0;
  $("yonkes-empty").hidden = yonkes.length > 0;
}

async function registerPayment(y) {
  if (!confirm(`¿Registrar pago de 1 mes para ${y.name}?`)) return;
  try {
    const updated = await api("POST", `/api/yonkes/${y.id}/payments`, { months: 1 });
    state.yonkes.set(updated.id, updated);
    renderYonkes();
    toast(`${y.name}: pagado hasta el ${formatDate(updated.payment_due_date)}`, "ok");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function setSuspended(y, suspend) {
  const question = suspend
    ? `¿Suspender a ${y.name}? Se desconectará de inmediato y dejará de recibir solicitudes.`
    : `¿Reactivar a ${y.name}?`;
  if (!confirm(question)) return;
  try {
    const updated = await api("PATCH", `/api/yonkes/${y.id}`, {
      subscription_status: suspend ? "suspended" : "active",
    });
    state.yonkes.set(updated.id, updated);
    renderYonkes();
    if (!suspend && !updated.has_access) toast("Reactivado, pero su pago está vencido: registra un pago.", "error");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function regenerateToken(y) {
  if (!confirm(`¿Generar un código nuevo para ${y.name}? Sus dispositivos actuales se desconectarán y tendrán que activarse otra vez.`)) return;
  try {
    showCredentials(await api("POST", `/api/yonkes/${y.id}/token`), `Nuevo código de ${y.name}`);
  } catch (err) {
    toast(err.message, "error");
  }
}

function showCredentials(cred, title) {
  const link = `${location.origin}${cred.activation_path}`;
  $("cred-title").textContent = title;
  $("cred-token").textContent = cred.access_token;
  $("cred-link").value = link;
  $("cred-whatsapp").href = whatsappUrl(
    cred.yonke.phone,
    `Hola ${cred.yonke.name}, este es tu acceso a las solicitudes de piezas. Ábrelo en tu teléfono: ${link}`,
  );
  $("credentials").showModal();
}

$("cred-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("cred-link").value);
    toast("Enlace copiado", "ok");
  } catch {
    $("cred-link").select();
  }
};
$("cred-close").onclick = () => $("credentials").close();

// --- boot -------------------------------------------------------------------

setInterval(() => {
  for (const el of document.querySelectorAll("[data-ts]")) el.textContent = timeAgo(el.dataset.ts);
}, 60000);

registerServiceWorker();
setupInstallButton($("install"));

if (store(TOKEN_KEY)) start();
else logout();
