const form = document.querySelector("#charge-form");
const mode = document.querySelector("#mode");
const channel = document.querySelector("#channel");
const feedback = document.querySelector("#feedback");
const actionFeedback = document.querySelector("#action-feedback");
const actions = document.querySelector("#charge-actions");
const liveOption = document.querySelector("#live-option");
const qr = document.querySelector("#pay-qr");
const operatorToken = document.querySelector("#operator-token");
const expiry = document.querySelector("#expiry");
const copyLink = document.querySelector("#copy-link");
const simulatePayment = document.querySelector("#simulate-payment");
const requestRefund = document.querySelector("#request-refund");
const confirmRefund = document.querySelector("#confirm-refund");
const printReceipt = document.querySelector("#print-receipt");
const whatsapp = document.querySelector("#whatsapp");
const paymentLinkId = location.pathname.match(/^\/p\/([\w-]{32})$/)?.[1];
const showControls = !paymentLinkId;
let charge;
let polling;
let requestKey;
let chargeOperator;

async function api(url, { body, headers = {} } = {}) {
  const response = await fetch(url, body === undefined ? { headers } : {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(errorBody?.error || "La operación no está disponible. Actualiza e inténtalo de nuevo.");
  }
  return response.json();
}

function chargeUrl() {
  return new URL(`/p/${charge.id}`, location.origin).href;
}

function render(data) {
  charge = data;
  const simulated = data.mode === "simulation";
  const paid = data.status === "paid";
  const pending = data.status === "pending";
  const statuses = {
    pending: simulated ? "Pendiente de pago simulado" : "Pendiente · Escanea el QR en tu app bancaria",
    paid: simulated ? "Pago simulado confirmado" : "Pago CoDi confirmado por Pey",
    expired: "Solicitud vencida",
    creating: "Generando la solicitud con Pey",
    failed: "Pey rechazó la solicitud. Revisa la cuenta de cobro.",
    needs_review: "No se pudo verificar la creación. Revisa Pey antes de generar otro cobro.",
  };

  document.querySelector("#charge-label").textContent = simulated ? "MODO SIMULACIÓN" : "COBRO REAL · PEY CODI";
  const shownRefund = simulated || showControls ? data.refund : null;
  document.querySelector("#charge-status").textContent = shownRefund?.status === "pending"
    ? "Devolución simulada pendiente"
    : shownRefund?.status === "complete" ? "Devolución simulada completada" : statuses[data.status];
  expiry.hidden = !pending && !data.latePayment;
  expiry.textContent = pending
    ? `Vence a las ${new Date(data.expiresAt).toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit", timeZone: "America/Mexico_City" })} (CDMX).`
    : "El abono llegó después del vencimiento. Revisa la conciliación.";
  qr.hidden = simulated || !pending;
  if (!qr.hidden) {
    const url = `/api/charges/${data.id}/qr`;
    if (qr.getAttribute("src") !== url) qr.src = url;
  }
  actions.hidden = !showControls;
  copyLink.hidden = !(pending || paid);
  simulatePayment.hidden = !(simulated && pending);
  const canSimulateRefund = simulated || Boolean(chargeOperator);
  requestRefund.hidden = !paid || Boolean(data.refund) || !canSimulateRefund;
  confirmRefund.hidden = data.refund?.status !== "pending" || !canSimulateRefund;
  printReceipt.hidden = !(paid && data.channel === "pos" && !data.refund);
  whatsapp.hidden = printReceipt.hidden;
  if (!whatsapp.hidden) {
    const text = `PeyCash · ${simulated ? "Ticket de prueba" : "Pago CoDi confirmado"} · $0.01 MXN · ${chargeUrl()}`;
    whatsapp.href = `https://wa.me/?text=${encodeURIComponent(text)}`;
  }
  clearTimeout(polling);
  if (pending || data.status === "creating" || (!simulated && data.status === "expired")) {
    scheduleRefresh(data.id, data.status === "expired" ? 12000 : 2400);
  }
}

function scheduleRefresh(id, delay) {
  polling = setTimeout(async () => {
    try {
      const updated = await api(`/api/charges/${id}`);
      if (charge?.id === id) render(updated);
    } catch {
      if (charge?.id === id) scheduleRefresh(id, 6000);
    }
  }, delay);
}

document.querySelectorAll("[data-channel]").forEach((link) => {
  link.addEventListener("click", () => {
    channel.value = link.dataset.channel;
    requestKey = undefined;
  });
});

form.addEventListener("change", () => {
  document.querySelector("#operator").hidden = mode.value !== "live";
  requestKey = undefined;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector("button");
  submit.disabled = true;
  feedback.textContent = "Generando solicitud…";
  actionFeedback.textContent = "";
  requestKey ??= crypto.randomUUID();
  try {
    const token = operatorToken.value;
    const data = await api("/api/charges", {
      body: { mode: mode.value, channel: channel.value },
      headers: { "Idempotency-Key": requestKey, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (data.status !== "creating" && data.status !== "needs_review") {
      requestKey = undefined;
    }
    chargeOperator = data.mode === "live" ? token : undefined;
    render(data);
    feedback.textContent = "";
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    operatorToken.value = "";
    submit.disabled = false;
  }
});

async function demoAction(button, action, body = {}) {
  button.disabled = true;
  actionFeedback.textContent = "";
  try {
    const headers = charge.mode === "live" && chargeOperator
      ? { Authorization: `Bearer ${chargeOperator}` } : {};
    render(await api(`/api/charges/${charge.id}/${action}`, { body, headers }));
  } catch (error) {
    actionFeedback.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

simulatePayment.addEventListener("click", () => demoAction(simulatePayment, "simulated-payment"));
requestRefund.addEventListener("click", () => demoAction(requestRefund, "simulated-refund", { step: "request" }));
confirmRefund.addEventListener("click", () => demoAction(confirmRefund, "simulated-refund", { step: "confirm" }));
printReceipt.addEventListener("click", () => window.print());
copyLink.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(chargeUrl());
    actionFeedback.textContent = "Enlace copiado.";
  } catch {
    actionFeedback.textContent = chargeUrl();
  }
});

if (paymentLinkId) {
  document.body.classList.add("payment-view");
  document.querySelector("#demo-title").textContent = "Solicitud CoDi";
  api(`/api/charges/${paymentLinkId}`).then(render).catch((error) => {
    document.querySelector("#charge-status").textContent = error.message;
  });
} else {
  api("/api/health").then(({ liveReady }) => {
    liveOption.disabled = !liveReady;
    if (!liveReady) liveOption.textContent = "Cobro real · Pendiente configurar Pey";
  }).catch(() => { liveOption.disabled = true; });
}
