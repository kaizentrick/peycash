import express from "express";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { Webhook } from "standardwebhooks";
import { jwtVerify } from "jose";

const CENTS = 1;
const LIFETIME = 600;
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const chargeId = /^[A-Za-z0-9_-]{32}$/;
const validChannels = new Set(["ecommerce", "pos", "agent"]);

const digest = (value) => createHash("sha256").update(value).digest();

function equalSecret(expected, supplied) {
  return typeof supplied === "string" && timingSafeEqual(digest(expected), digest(supplied));
}

function cents(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 1e-8 ? rounded : null;
}

function publicCharge(row) {
  const state = row.status === "pending" && row.expires_at <= Date.now() ? "expired" : row.status;
  return {
    id: row.id,
    mode: row.mode,
    channel: row.channel,
    amountCents: row.amount_cents,
    status: state,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    latePayment: Boolean(row.paid_at && row.paid_at > row.expires_at),
    refund: row.refund === "none" ? null : { mode: "simulation", status: row.refund },
  };
}

class PeyRejected extends Error {}

function peyClient(request, config) {
  return async ({ reference }) => {
    const response = await request("https://api.pey.mx/codi/qr", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        amount: CENTS / 100,
        concept: `PeyCash Demo ${reference}`,
        expiration: LIFETIME,
        numRef: reference,
        generateImage: false,
        ...(config.bankAccountId ? { bankAccountId: config.bankAccountId } : {}),
      }),
    });
    if (response.status >= 400 && response.status < 500) throw new PeyRejected();
    if (!response.ok) throw new Error("Pey unavailable");

    const qr = await response.json();
    if (typeof qr.id !== "string" || !qr.id || typeof qr.qrString !== "string" || !qr.qrString) {
      throw new Error("Invalid Pey response");
    }
    return qr;
  };
}

export function makeApp({ database, config = {}, request = fetch } = {}) {
  const db = database ?? new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS charges (
      id TEXT PRIMARY KEY, mode TEXT NOT NULL, channel TEXT NOT NULL,
      status TEXT NOT NULL, amount_cents INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, paid_at INTEGER, created_at INTEGER NOT NULL,
      request_key TEXT UNIQUE, pey_id TEXT UNIQUE, pey_tx TEXT UNIQUE, qr TEXT,
      refund TEXT NOT NULL DEFAULT 'none'
    );
  `);
  const app = express();
  const liveReady = Boolean(config.apiKey && config.webhookSecret && config.operatorToken);
  const signer = liveReady ? new Webhook(config.webhookSecret) : null;
  const createPeyQr = peyClient(request, config);
  const load = db.prepare("SELECT * FROM charges WHERE id = ?");
  const byRequest = db.prepare("SELECT * FROM charges WHERE request_key = ?");
  const ipBuckets = new Map();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.set({
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    if (req.path.startsWith("/api/") || req.path.startsWith("/p/")) {
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex, nofollow");
    }
    next();
  });

  app.post("/api/webhooks/pey", express.raw({ type: "application/json", limit: "64kb" }), (req, res) => {
    if (!signer) return res.sendStatus(503);
    if (!Buffer.isBuffer(req.body)) return res.sendStatus(400);

    let event;
    try {
      event = signer.verify(req.body, {
        "webhook-id": req.get("webhook-id") || "",
        "webhook-timestamp": req.get("webhook-timestamp") || "",
        "webhook-signature": req.get("webhook-signature") || "",
      });
    } catch {
      return res.sendStatus(401);
    }

    if (event?.type !== "codi.qr.payment_received") return res.sendStatus(204);
    if (typeof event.codiQrId !== "string" || typeof event.transactionId !== "string") {
      return res.sendStatus(422);
    }
    const row = db.prepare("SELECT * FROM charges WHERE pey_id = ? AND mode = 'live'").get(event.codiQrId);
    if (!row) return res.sendStatus(503);
    if (cents(event.amount) !== row.amount_cents) return res.sendStatus(422);
    if (config.bankAccountId && event.bankAccountId !== config.bankAccountId) return res.sendStatus(422);
    if (row.pey_tx === event.transactionId) return res.sendStatus(204);
    if (row.pey_tx) return res.sendStatus(409);

    const paidAt = Number.isSafeInteger(event.datePaid) && event.datePaid > 0 ? event.datePaid * 1000 : Date.now();
    try {
      const result = db.prepare(
        "UPDATE charges SET status = 'paid', paid_at = ?, pey_tx = ? WHERE id = ? AND status = 'pending'"
      ).run(paidAt, event.transactionId, row.id);
      if (result.changes === 1) return res.sendStatus(204);
    } catch (error) {
      if ((error.errcode & 255) === 19) return res.sendStatus(409);
      throw error;
    }
    const updated = load.get(row.id);
    return res.sendStatus(updated.pey_tx === event.transactionId ? 204 : 409);
  });

  app.use(express.json({ limit: "8kb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, liveReady }));

  function canOperate(req) {
    const operator = req.get("authorization")?.match(/^Bearer ([^ ]+)$/)?.[1];
    return liveReady && equalSecret(config.operatorToken, operator);
  }

  async function authorizePos(req, res, next) {
    const { shopifyClientId, shopifyClientSecret, shopifyDevShop } = config;
    if (!liveReady || !shopifyClientId || !shopifyClientSecret || !shopifyDevShop) {
      return res.status(503).json({ error: "Falta conectar la tienda Shopify de desarrollo y las credenciales de Pey." });
    }
    const token = req.get("authorization")?.match(/^Bearer ([^ ]+)$/)?.[1];
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(shopifyClientSecret), {
        algorithms: ["HS256"], audience: shopifyClientId,
        requiredClaims: ["exp", "dest", "sub"],
      });
      if (new URL(payload.dest).origin !== `https://${shopifyDevShop}`) throw new Error("Wrong shop");
    } catch {
      return res.status(401).json({ error: "La sesión no pertenece a la tienda de desarrollo autorizada." });
    }
    next();
  }

  app.use("/api/pos/charges", (req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Idempotency-Key",
    });
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  function limit(req, res, next) {
    const now = Date.now();
    for (const [key, entry] of ipBuckets) {
      if (now >= entry.until) ipBuckets.delete(key);
    }
    const ip = req.ip ?? "unknown";
    const entry = ipBuckets.get(ip) ?? { until: now + 60000, count: 0 };
    if (entry.count >= 20 || ipBuckets.size >= 10000) {
      return res.status(429).json({ error: "Espera un minuto antes de volver a intentar." });
    }
    entry.count++;
    ipBuckets.set(ip, entry);
    next();
  }

  async function createCharge(req, res) {
    const pos = req.path === "/api/pos/charges";
    const { mode, channel } = pos ? { mode: "live", channel: "pos" } : req.body ?? {};
    if (!["simulation", "live"].includes(mode) || !validChannels.has(channel)) {
      return res.status(400).json({ error: "Selecciona un canal y un modo de cobro válidos." });
    }
    const live = mode === "live";
    if (live && !pos && !canOperate(req)) {
      return res.status(liveReady ? 401 : 503).json({
        error: liveReady ? "La clave de la persona operadora no es válida." : "El cobro real requiere configurar Pey y el webhook.",
      });
    }
    const requestKey = req.get("idempotency-key");
    if (!/^[0-9a-f-]{36}$/i.test(requestKey ?? "")) {
      return res.status(400).json({ error: "Falta el identificador de la solicitud." });
    }
    const scope = `${pos ? "shopify-pos" : mode}:${requestKey}`;
    const previous = byRequest.get(scope);
    if (previous) {
      if (previous.channel !== channel) return res.status(409).json({ error: "La solicitud ya pertenece a otro canal." });
      return res.json(publicCharge(previous));
    }

    const id = randomBytes(24).toString("base64url");
    const now = Date.now();
    const expiry = now + LIFETIME * 1000;
    db.prepare(
      "INSERT INTO charges (id, mode, channel, status, amount_cents, expires_at, created_at, request_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, mode, channel, live ? "creating" : "pending", CENTS, expiry, now, scope);
    if (live) {
      try {
        const { id: peyId, qrString } = await createPeyQr({ reference: String(randomInt(1000000, 10000000)) });
        db.prepare("UPDATE charges SET pey_id = ?, qr = ?, status = 'pending' WHERE id = ?").run(peyId, qrString, id);
      } catch (error) {
        if (error instanceof PeyRejected) {
          db.prepare("UPDATE charges SET status = 'failed' WHERE id = ?").run(id);
        } else {
          db.prepare("UPDATE charges SET status = 'needs_review' WHERE id = ?").run(id);
        }
      }
    }
    return res.status(201).json(publicCharge(load.get(id)));
  }
  app.post("/api/charges", limit, createCharge);
  app.post("/api/pos/charges", limit, authorizePos, createCharge);

  function findCharge(req, res, next) {
    const row = chargeId.test(req.params.id) ? load.get(req.params.id) : null;
    if (!row) return res.status(404).json({ error: "Este cobro no está disponible." });
    req.charge = row;
    next();
  }

  app.get("/api/charges/:id", findCharge, (req, res) => res.json(publicCharge(req.charge)));

  app.get("/api/pos/charges/:id", findCharge, (req, res) => {
    const row = req.charge;
    if (!row.request_key?.startsWith("shopify-pos:")) return res.sendStatus(404);
    const charge = publicCharge(row);
    res.json({ ...charge, qrPayload: charge.status === "pending" ? row.qr : null });
  });

  app.get("/api/charges/:id/qr", findCharge, async (req, res) => {
    const row = req.charge;
    if (row.mode !== "live" || !row.qr || publicCharge(row).status !== "pending") {
      return res.sendStatus(404);
    }
    const png = await QRCode.toBuffer(row.qr, { width: 320, margin: 2, errorCorrectionLevel: "M" });
    res.type("png").send(png);
  });

  app.post("/api/charges/:id/simulated-payment", limit, findCharge, (req, res) => {
    const id = req.charge.id;
    db.prepare("UPDATE charges SET status = 'paid', paid_at = ? WHERE id = ? AND mode = 'simulation' AND status = 'pending' AND expires_at > ?")
      .run(Date.now(), id, Date.now());
    const result = publicCharge(load.get(id));
    if (result.mode !== "simulation" || result.status !== "paid") return res.sendStatus(409);
    return res.json(result);
  });

  app.post("/api/charges/:id/simulated-refund", limit, findCharge, (req, res) => {
    const row = req.charge;
    if (row.mode === "live" && !canOperate(req)) {
      return res.status(401).json({ error: "Se necesita autorización para simular una devolución sobre un cobro real." });
    }
    if (row.status !== "paid") return res.sendStatus(409);
    const step = req.body?.step;
    if (step === "request") {
      db.prepare("UPDATE charges SET refund = 'pending' WHERE id = ? AND refund = 'none'").run(row.id);
    } else if (step === "confirm") {
      db.prepare("UPDATE charges SET refund = 'complete' WHERE id = ? AND refund = 'pending'").run(row.id);
      if (load.get(row.id).refund !== "complete") return res.sendStatus(409);
    } else {
      return res.sendStatus(400);
    }
    return res.json(publicCharge(load.get(row.id)));
  });

  app.get("/p/:id", (req, res) => {
    if (!chargeId.test(req.params.id) || !load.get(req.params.id)) return res.sendStatus(404);
    return res.sendFile(join(publicDir, "index.html"));
  });
  app.use(express.static(publicDir));
  app.use((_req, res) => res.sendStatus(404));
  app.use((error, _req, res, _next) => {
    const status = error.status === 400 || error.status === 413 ? error.status : 500;
    res.status(status).json({ error: "No pudimos completar la solicitud." });
  });
  return app;
}

export function start() {
  const dir = process.env.PEY_DATA_DIR || (process.env.NODE_ENV === "production"
    ? join(homedir(), ".peycash") : ".data");
  process.umask(0o077);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(dir, "demo.sqlite"));
  const config = {
    apiKey: process.env.PEY_API_KEY,
    webhookSecret: process.env.PEY_WEBHOOK_SECRET,
    operatorToken: process.env.PEY_OPERATOR_TOKEN,
    shopifyClientId: process.env.SHOPIFY_API_KEY,
    shopifyClientSecret: process.env.SHOPIFY_API_SECRET,
    shopifyDevShop: process.env.SHOPIFY_POS_DEV_SHOP,
    bankAccountId: process.env.PEY_BANK_ACCOUNT_ID,
  };
  const app = makeApp({ database, config });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, "0.0.0.0", () => console.log(`PeyCash listening on ${port}`));
}
