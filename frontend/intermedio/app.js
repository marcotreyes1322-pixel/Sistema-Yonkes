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
  money,
  notify,
  registerServiceWorker,
  setupInstallButton,
  store,
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

// --- connection & auth ------------------------------------------------------

const socket = new LiveSocket({
  path: "/ws/broker",
  getToken: () => store(TOKEN_KEY),
  onMessage: handleMessage,
  onStatus: (s) => {
    $("status").dataset.state = s;
    $("status").textContent = STATUS_TEXT[s];
  },
  onDenied: () => logout("Token incorrecto."),
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
    logout("Tu sesión expiró. Vuelve a entrar.");
    throw new Error("No autorizado");
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

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  store(TOKEN_KEY, $("token").value.trim());
  enableAlerts();
  start();
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
  $("online-count").textContent = `${n} yonke${n === 1 ? "" : "s"}`;
  $("online-count").dataset.state = n ? "online" : "offline";
}

// --- requests ---------------------------------------------------------------

$("request-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const reply = await socket.request("request.create", {
      part_name: form.elements.part_name.value.trim(),
      vehicle_model: form.elements.vehicle_model.value.trim(),
    });
    const n = reply.delivered_to;
    toast(n ? `Enviada a ${n} yonke${n === 1 ? "" : "s"} en línea ✔` : "Guardada, pero no hay yonkes en línea ahora", n ? "ok" : "");
    form.reset();
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
    .filter((r) => state.showClosed || r.status === "open")
    .sort((a, b) => (a.status === b.status ? b.timestamp.localeCompare(a.timestamp) : a.status === "open" ? -1 : 1));
  $("requests").replaceChildren(...list.map(requestCard));
  $("requests-empty").hidden = list.length > 0;
}

function requestCard(r) {
  const open = r.status === "open";
  const quotes = r.quotes || [];
  return h(
    "article.card",
    { style: open ? null : "opacity: .65" },
    h(
      "div.row",
      h("div.grow", h("h3.req-title", r.part_name), h("p.req-vehicle", r.vehicle_model)),
      h("span.badge", { dataset: { ts: r.timestamp } }, timeAgo(r.timestamp)),
      h(open ? "span.badge.ok" : "span.badge", open ? "Abierta" : "Cerrada"),
    ),
    quotes.length
      ? h("div", { style: "margin-top: 8px" }, quotes.map((q, i) => quoteRow(r, q, i === 0)))
      : h(
          "p.muted.small",
          open ? `Esperando cotizaciones… (${state.online.size} yonkes en línea)` : "Sin cotizaciones.",
        ),
    open &&
      h(
        "div.row",
        { style: "margin-top: 8px; justify-content: flex-end" },
        h(
          "button.secondary.sm",
          {
            onclick: async () => {
              if (!confirm(`¿Cerrar la solicitud "${r.part_name}"? Los yonkes dejarán de verla.`)) return;
              try {
                await api("POST", `/api/requests/${r.id}/close`);
              } catch (err) {
                toast(err.message, "error");
              }
            },
          },
          "Cerrar solicitud",
        ),
      ),
  );
}

function quoteRow(r, q, best) {
  const wa = whatsappUrl(q.yonke.phone, `Hola ${q.yonke.name}, sobre tu cotización de ${r.part_name} (${r.vehicle_model}) por ${money(q.price)}: `);
  return h(
    `div.quote${best && r.quotes.length > 1 ? ".best" : ""}`,
    h(
      "div",
      h("strong", q.yonke.name),
      " ",
      h(`span.badge.${q.condition === "good" ? "ok" : q.condition === "regular" ? "warn" : "danger"}`, CONDITIONS[q.condition]),
      best && r.quotes.length > 1 ? h("span.badge.ok", { style: "margin-left: 4px" }, "Mejor precio") : null,
    ),
    h("div.price", money(q.price)),
    h(
      "div.small.muted",
      q.notes ? h("div", q.notes) : null,
      h("a", { href: `tel:${q.yonke.phone}` }, q.yonke.phone),
      " · ",
      h("a", { href: wa, target: "_blank", rel: "noopener" }, "WhatsApp"),
    ),
    h("div.small.muted", { style: "text-align: right" }, timeAgo(q.created_at)),
  );
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
  const button = form.querySelector("button");
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

function renderYonkes() {
  const yonkes = [...state.yonkes.values()].sort((a, b) => a.name.localeCompare(b.name, "es"));
  $("yonkes").replaceChildren(
    ...yonkes.map((y) => {
      const online = state.online.has(y.id);
      const suspended = y.subscription_status === "suspended";
      return h(
        "tr",
        h("td", { dataset: { label: "En línea" } }, h(`span.dot${online ? ".on" : ""}`, { title: online ? "En línea" : "Desconectado" })),
        h("td", { dataset: { label: "Yonke" } }, h("strong", y.name)),
        h("td", { dataset: { label: "Teléfono" } }, h("a", { href: `tel:${y.phone}` }, y.phone)),
        h("td", { dataset: { label: "Suscripción" } }, subscriptionBadge(y)),
        h("td", { dataset: { label: "Pagado hasta" } }, formatDate(y.payment_due_date)),
        h(
          "td",
          h(
            "div.row",
            { style: "justify-content: flex-end" },
            h("button.sm", { onclick: () => registerPayment(y) }, "+1 mes"),
            h(
              "button.secondary.sm",
              { onclick: () => setSuspended(y, !suspended) },
              suspended ? "Reactivar" : "Suspender",
            ),
            h("button.secondary.sm", { onclick: () => regenerateToken(y) }, "Nuevo código"),
          ),
        ),
      );
    }),
  );
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
