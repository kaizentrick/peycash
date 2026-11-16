import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

const base = "https://pey.kaizentrick.com";
const reference = "peycash_demo_charge";
const attempt = "peycash_demo_attempt";

function eligible(cart) {
  return cart.currency === "MXN" && /^0\.010*$/.test(cart.grandTotal) && cart.lineItems.length > 0;
}

function fingerprint(cart) {
  return JSON.stringify([cart.currency, cart.grandTotal, cart.lineItems.map(({ uuid, quantity }) => [uuid, quantity])]);
}

function binding(cart, key) {
  try {
    const value = JSON.parse(cart.properties?.[key] || "null");
    return value?.cart === fingerprint(cart) && typeof value.id === "string" ? value.id : null;
  } catch {
    return null;
  }
}

async function api(path, options = {}) {
  const response = await fetch(base + path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || "No se pudo consultar PeyCash. Revisa la conexión e inténtalo de nuevo.");
  }
  return response.json();
}

function Payment() {
  const [cart, setCart] = useState(shopify.cart.current.value);
  const [payment, setPayment] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const id = binding(cart, reference);
  const changed = !id && Boolean(cart.properties?.[reference] || (cart.properties?.[attempt] && !binding(cart, attempt)));

  useEffect(() => shopify.cart.current.subscribe(setCart), []);
  useEffect(() => {
    if (!id) return;
    let stop = false;
    let timer;
    async function refresh() {
      try {
        const current = await api(`/api/pos/charges/${id}`);
        if (stop) return;
        setPayment(current);
        setError("");
        if (["paid", "failed", "needs_review"].includes(current.status)) return;
      } catch (problem) {
        if (stop) return;
        setError(problem.message);
      }
      timer = setTimeout(refresh, 2500);
    }
    refresh();
    return () => { stop = true; clearTimeout(timer); };
  }, [id]);

  async function createPayment() {
    if (running.current) return;
    const current = shopify.cart.current.value;
    if (changed || !eligible(current) || current.properties?.[reference]) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const token = await shopify.session.getSessionToken();
      if (!token) throw new Error("Inicia sesión con un usuario autorizado de Shopify POS.");
      const details = fingerprint(current);
      const requestId = binding(current, attempt) || crypto.randomUUID();
      await shopify.cart.addCartProperties({ [attempt]: JSON.stringify({ id: requestId, cart: details }) });
      const charge = await api("/api/pos/charges", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": requestId },
      });
      if (fingerprint(shopify.cart.current.value) !== details) {
        throw new Error("El carrito cambió durante el cobro. Revisa la solicitud en PeyCash antes de continuar.");
      }
      await shopify.cart.addCartProperties({ [reference]: JSON.stringify({ id: charge.id, cart: details }) });
      setPayment(charge);
    } catch (problem) {
      setError(problem.message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  const current = payment?.id === id ? payment : null;
  const ready = current?.status === "paid" && !current.latePayment && eligible(cart);

  return (
    <s-page heading="Cobrar con CoDi">
      <s-section heading="Prueba de $0.01 MXN">
        <s-stack gap="base">
          <s-text>Usa un carrito de prueba con total de $0.01 MXN.</s-text>
          {changed && <s-text>El carrito cambió después de iniciar el cobro. Revisa la solicitud anterior en PeyCash.</s-text>}
          {!id && <s-button disabled={busy || changed || !eligible(cart)} onClick={createPayment}>Generar QR CoDi</s-button>}
          {id && !current && <s-text>Consultando el cobro…</s-text>}
          {current?.status === "pending" && (
            <s-stack gap="base">
              <s-qr-code content={current.qrPayload} />
              <s-text>Escanea con una app bancaria compatible con CoDi. Esperando confirmación de Pey.</s-text>
            </s-stack>
          )}
          {current?.status === "creating" && <s-text>Generando el QR…</s-text>}
          {current?.status === "expired" && <s-text>QR vencido. Revisa el cobro en PeyCash antes de continuar.</s-text>}
          {current?.status === "needs_review" && <s-text>Revisa la solicitud en Pey antes de volver a cobrar.</s-text>}
          {current?.status === "failed" && <s-text>Pey rechazó el cobro. Revisa la cuenta de prueba.</s-text>}
          {current?.latePayment && <s-text>El pago llegó tarde. Revisa la conciliación antes de cerrar la venta.</s-text>}
          {ready && <s-stack gap="base">
            <s-text>Pago confirmado por Pey. Vuelve a la caja, elige CoDi como método personalizado, cierra la venta e imprime el recibo.</s-text>
            <s-button onClick={() => {
              const liveCart = shopify.cart.current.value;
              if (eligible(liveCart) && binding(liveCart, reference) === id) shopify.navigation.close();
              else setError("El carrito cambió. Verifica el cobro antes de cerrar la venta.");
            }}>Volver a la caja</s-button>
          </s-stack>}
          {error && <s-text>{error}</s-text>}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export default function modal() {
  render(<Payment />, document.body);
}
