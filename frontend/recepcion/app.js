// Yonke app: receives part requests live and sends quotes back.
import {
  CONDITIONS,
  LiveSocket,
  STATUS_TEXT,
  alertsEnabled,
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

const TOKEN_KEY = "yonke.token";
const DISMISSED_KEY = "yonke.dismissedWon"; // won requests the yonke already acknowledged
const $ = (id) => document.getElementById(id);

const state = {
  requests: new Map(), // id -> request (with my_quote)
  cards: new Map(), // id -> card element
  editing: new Set(), // request ids whose quote is being edited
  unseen: 0,
  deniedMessage: "",
};

// --- activation -------------------------------------------------------------

// Activation link from the broker: /recepcion/#token=XXXX-XXXX-XXXX
const hashToken = new URLSearchParams(location.hash.slice(1)).get("token");
if (hashToken) {
  store(TOKEN_KEY, hashToken.trim().toUpperCase());
  history.replaceState(null, "", location.pathname); // don't leave the token in the URL bar
}

const socket = new LiveSocket({
  path: "/ws/yonke",
  getToken: () => store(TOKEN_KEY),
  onMessage: handleMessage,
  onStatus: (s) => {
    $("status").dataset.state = s;
    $("status").textContent = STATUS_TEXT[s];
  },
  onDenied: (reason) => {
    if (reason === "token") {
      store(TOKEN_KEY, null);
      showLogin(state.deniedMessage || "No reconocimos ese código. Revísalo, o pídenos uno nuevo y con gusto te lo damos.");
    } else {
      $("denied").textContent = `${state.deniedMessage} Esta pantalla se actualizará sola en cuanto se reactive.`;
      $("denied").hidden = false;
      clearRequests();
    }
  },
});

function showLogin(error = "") {
  $("feed").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = error;
  $("login-error").hidden = !error;
  $("token").focus();
}

function showFeed() {
  $("login").hidden = true;
  $("feed").hidden = false;
  $("alerts-banner").hidden = alertsEnabled();
  socket.start();
}

$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const token = $("token").value.trim().toUpperCase();
  if (!token) return;
  store(TOKEN_KEY, token);
  unlockAlerts();
  showFeed();
});

$("logout").addEventListener("click", (e) => {
  e.preventDefault();
  if (!confirm("¿Quitar el código de este dispositivo?")) return;
  socket.stop();
  store(TOKEN_KEY, null);
  clearRequests();
  showLogin();
});

// Browsers only allow sound after a user gesture: the first tap anywhere unlocks it.
async function unlockAlerts() {
  if (await enableAlerts()) $("alerts-banner").hidden = true;
}
$("enable-alerts").addEventListener("click", unlockAlerts);
// "click" on document runs after the tapped button's own handler, so hiding the
// banner can't shift the layout under the finger and swallow that first tap.
document.addEventListener("click", unlockAlerts, { once: true });

// --- server messages --------------------------------------------------------

function handleMessage(msg) {
  switch (msg.type) {
    case "hello":
      state.deniedMessage = "";
      $("denied").hidden = true;
      $("title").textContent = msg.yonke.name;
      $("whoami").textContent = `${msg.yonke.name} · pagado hasta el ${formatDate(msg.yonke.payment_due_date)}`;
      renderExpiry(msg.yonke.payment_due_date);
      clearRequests();
      // Server sends newest first; insert oldest first so newest ends on top.
      for (const r of [...msg.requests].reverse()) if (!(r.won && dismissedWon().includes(r.id))) upsertRequest(r);
      break;

    case "request.won":
      upsertRequest(msg.request, { fresh: true });
      beep(4);
      notify("¡Buenas noticias! 🎉", `Seleccionamos tu ${msg.request.part_name} (${msg.request.vehicle_model}). Por favor apártala.`, {
        tag: `won-${msg.request.id}`,
      });
      break;

    case "request.new":
      upsertRequest(msg.request, { fresh: true });
      beep(3);
      notify("Nueva solicitud", `${msg.request.part_name} · ${msg.request.vehicle_model}`, {
        tag: `req-${msg.request.id}`,
      });
      if (document.visibilityState !== "visible") {
        state.unseen++;
        updateTitle();
      }
      break;

    case "request.closed":
      // Same gentle notice whether another yonke was picked or the request was just
      // closed: the yonke never learns the sale went elsewhere.
      showRequestCovered(msg.request_id);
      break;

    case "quote.saved": {
      const req = state.requests.get(msg.quote.request_id);
      if (!req) break;
      req.my_quote = msg.quote;
      state.editing.delete(req.id);
      renderCard(req);
      break;
    }

    case "access_denied":
      state.deniedMessage = msg.message;
      break;
  }
}

function renderExpiry(dueDate) {
  const days = daysUntil(dueDate);
  const banner = $("expiry");
  banner.hidden = days > 5;
  banner.textContent =
    days === 0
      ? "Tu suscripción vence hoy. Renuévala para seguir recibiendo solicitudes sin interrupción."
      : `Tu suscripción vence en ${days} día${days === 1 ? "" : "s"} (${formatDate(dueDate)}). Recuerda renovarla para no perderte ninguna solicitud.`;
}

// --- request cards ----------------------------------------------------------

function upsertRequest(req, { fresh = false } = {}) {
  const existing = state.requests.get(req.id);
  if (existing) req = { ...existing, ...req, my_quote: req.my_quote ?? existing.my_quote };
  state.requests.set(req.id, req);
  const card = renderCard(req);
  if (!existing) $("requests").prepend(card);
  if (fresh) {
    card.classList.add("fresh", "arrive"); // "arrive" animates once; "fresh" keeps the border a while
    setTimeout(() => state.cards.get(req.id)?.classList.remove("fresh"), 8000);
  }
  updateEmpty();
}

function removeRequest(id) {
  const card = state.cards.get(id);
  state.requests.delete(id);
  state.cards.delete(id);
  state.editing.delete(id);
  if (card) {
    card.classList.add("leaving");
    setTimeout(() => card.remove(), 400);
  }
  updateEmpty();
}

/** The request no longer needs quotes: thank the yonke kindly, then drop the card. */
function showRequestCovered(id) {
  const req = state.requests.get(id);
  const old = state.cards.get(id);
  if (!req || !old) return removeRequest(id);
  state.requests.delete(id);
  state.cards.delete(id);
  state.editing.delete(id);
  const card = h(
    "article.card.gone",
    { role: "status" },
    h("div.gone-icon", { "aria-hidden": "true" }, "✓"),
    h(
      "div.grow",
      h("div.gone-title", "Solicitud cubierta"),
      h("div.gone-part", `${req.part_name} · ${req.vehicle_model}`),
      h("p.gone-msg", "Gracias por revisarla. Ya no es necesario buscarla; te avisamos en cuanto llegue la siguiente."),
    ),
  );
  old.replaceWith(card);
  updateEmpty();
  setTimeout(() => {
    card.classList.add("leaving");
    setTimeout(() => card.remove(), 400);
  }, 10000);
}

function dismissedWon() {
  try {
    return JSON.parse(store(DISMISSED_KEY) || "[]");
  } catch {
    return [];
  }
}

function clearRequests() {
  state.requests.clear();
  state.cards.clear();
  state.editing.clear();
  $("requests").replaceChildren();
  updateEmpty();
}

function updateEmpty() {
  $("empty").hidden = state.requests.size > 0 || !$("denied").hidden;
}

/** (Re)builds a card in place, keeping its position in the list. */
function renderCard(req) {
  const card = h(
    "article.card.req",
    { dataset: { id: req.id } },
    h(
      "header.req-head",
      h(
        "div.grow",
        h("span.badge.new.only-fresh", "Nueva"),
        h("h2.req-title", req.part_name),
        h("p.req-vehicle", h("span.chip", "🚗 ", req.vehicle_model)),
      ),
      h("span.req-time", { dataset: { ts: req.timestamp } }, timeAgo(req.timestamp)),
    ),
    h(
      "div.req-body",
      req.won ? wonView(req) : req.my_quote && !state.editing.has(req.id) ? myQuoteView(req) : quoteForm(req),
    ),
  );
  if (req.won) card.classList.add("won");
  const old = state.cards.get(req.id);
  if (old) {
    if (old.classList.contains("fresh")) card.classList.add("fresh");
    old.replaceWith(card);
  }
  state.cards.set(req.id, card);
  return card;
}

function wonView(req) {
  const q = req.my_quote;
  return h(
    "div.stack",
    h(
      "div.won-msg",
      h("div.won-icon", { "aria-hidden": "true" }, "🎉"),
      h(
        "div",
        h("strong", "¡Buenas noticias!"),
        h("div", "Seleccionamos tu cotización. Por favor aparta la pieza; en breve te contactamos para coordinar la entrega."),
      ),
    ),
    q &&
      h(
        "div.won-quote",
        h("span.muted", "Tu cotización"),
        h("strong", money(q.price)),
        h("span", `${CONDITIONS[q.condition]}${q.notes ? ` · ${q.notes}` : ""}`),
      ),
    h(
      "button.secondary.block",
      {
        type: "button",
        onclick: () => {
          const ids = dismissedWon().filter((x) => x !== req.id).slice(-50);
          store(DISMISSED_KEY, JSON.stringify([...ids, req.id]));
          removeRequest(req.id);
        },
      },
      "Listo, ya la aparté",
    ),
  );
}

function myQuoteView(req) {
  const q = req.my_quote;
  return h(
    "div.my-quote.row",
    h(
      "div.grow",
      h("strong", `Cotizaste ${money(q.price)}`),
      h("div.small", `Estado: ${CONDITIONS[q.condition]}${q.notes ? ` · ${q.notes}` : ""}`),
    ),
    h(
      "button.secondary.sm",
      {
        type: "button",
        onclick: () => {
          state.editing.add(req.id);
          renderCard(req);
        },
      },
      "Editar",
    ),
  );
}

function quoteForm(req) {
  const q = req.my_quote;
  const name = `cond-${req.id}`;
  const form = h(
    "form.stack",
    { novalidate: true },
    h(
      "div",
      h("label", "Estado de la pieza"),
      h(
        "div.segmented",
        { role: "radiogroup" },
        Object.entries(CONDITIONS).map(([value, text]) => [
          h("input", { type: "radio", name, value, id: `${name}-${value}`, checked: q?.condition === value }),
          h("label", { for: `${name}-${value}` }, text),
        ]),
      ),
    ),
    h(
      "div",
      h("label", { for: `price-${req.id}` }, "Precio (MXN)"),
      h("input", {
        id: `price-${req.id}`,
        name: "price",
        type: "number",
        inputmode: "decimal",
        min: "1",
        step: "any",
        placeholder: "$0",
        value: q ? q.price : "",
      }),
    ),
    h(
      "div",
      h("label", { for: `notes-${req.id}` }, "Notas (opcional)"),
      h("textarea", {
        id: `notes-${req.id}`,
        name: "notes",
        maxlength: "500",
        rows: 2,
        placeholder: "Ej. lado izquierdo, con arnés, garantía 30 días…",
        value: q?.notes || "",
      }),
    ),
    h(
      "div.row",
      q &&
        h(
          "button.secondary",
          {
            type: "button",
            onclick: () => {
              state.editing.delete(req.id);
              renderCard(req);
            },
          },
          "Cancelar",
        ),
      h("button.grow", { type: "submit" }, q ? "Actualizar cotización" : "Enviar cotización"),
    ),
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const condition = form.querySelector(`input[name="${name}"]:checked`)?.value;
    const price = parseFloat(form.elements.price.value);
    if (!condition) return toast("Elige el estado de la pieza", "error");
    if (!(price > 0)) return toast("Escribe un precio válido", "error");
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await socket.request("quote.submit", {
        request_id: req.id,
        condition,
        price,
        notes: form.elements.notes.value.trim() || null,
      });
      toast("¡Gracias! Tu cotización fue enviada ✔", "ok");
    } catch (err) {
      toast(err.message, "error");
      button.disabled = false;
    }
  });
  return form;
}

// --- housekeeping -----------------------------------------------------------

function updateTitle() {
  document.title = state.unseen ? `(${state.unseen}) Yonke · Solicitudes` : "Yonke · Solicitudes";
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    state.unseen = 0;
    updateTitle();
  }
});

setInterval(() => {
  for (const el of document.querySelectorAll("[data-ts]")) el.textContent = timeAgo(el.dataset.ts);
}, 60000);

registerServiceWorker();
setupInstallButton($("install"));

if (store(TOKEN_KEY)) showFeed();
else showLogin();
