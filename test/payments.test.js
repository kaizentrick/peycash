import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { Webhook } from "standardwebhooks";
import { makeApp } from "../server.js";

const hookSecret = "whsec_" + Buffer.from("only used for testing webhook verification").toString("base64");
const operatorToken = "operator-test-token";

async function setup(t, options) {
  const server = makeApp(options).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init);
}

const post = (data, headers = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(data),
});

test("simulation can be shared, paid, and refunded in two explicit steps", async (t) => {
  const req = await setup(t);
  const input = post({ mode: "simulation", channel: "pos" }, { "Idempotency-Key": randomUUID() });
  const response = await req("/api/charges", input);
  assert.equal(response.status, 201);
  const { id, status, amountCents } = await response.json();
  assert.equal(status, "pending");
  assert.equal(amountCents, 1);
  const repeat = await (await req("/api/charges", input)).json();
  assert.equal(repeat.id, id);
  assert.equal((await req(`/p/${id}`)).status, 200);

  const endpoint = `/api/charges/${id}`;
  assert.equal((await req(`${endpoint}/qr`)).status, 404);
  assert.equal((await req(`${endpoint}/simulated-refund`, post({ step: "request" }))).status, 409);
  assert.equal((await (await req(`${endpoint}/simulated-payment`, post({}))).json()).status, "paid");
  const pending = await (await req(`${endpoint}/simulated-refund`, post({ step: "request" }))).json();
  assert.deepEqual(pending.refund, { mode: "simulation", status: "pending" });
  const complete = await (await req(`${endpoint}/simulated-refund`, post({ step: "confirm" }))).json();
  assert.deepEqual(complete.refund, { mode: "simulation", status: "complete" });
});

test("a live charge only settles on its matching, signed Pey webhook", async (t) => {
  let requests = 0;
  const req = await setup(t, {
    config: { apiKey: "server-only-key", webhookSecret: hookSecret, operatorToken, bankAccountId: "test-account" },
    request: async (url, init) => {
      requests++;
      assert.equal(url, "https://api.pey.mx/codi/qr");
      assert.equal(init.headers.Authorization, "Bearer server-only-key");
      const payload = JSON.parse(init.body);
      assert.equal(payload.amount, 0.01);
      assert.equal(payload.bankAccountId, "test-account");
      assert.match(payload.numRef, /^\d{7}$/);
      return Response.json({ id: "codi-test", qrString: "synthetic-codi" });
    },
  });
  const input = { mode: "live", channel: "ecommerce" };
  const key = { "Idempotency-Key": randomUUID() };
  assert.equal((await req("/api/charges", post(input, key))).status, 401);
  const live = post(input, { ...key, Authorization: `Bearer ${operatorToken}` });
  const data = await (await req("/api/charges", live)).json();
  const chargePath = `/api/charges/${data.id}`;
  assert.equal((await req("/api/charges", live)).status, 200);
  assert.equal(requests, 1);
  assert.match((await req(`${chargePath}/qr`)).headers.get("content-type"), /^image\/png/);
  assert.equal((await req(`${chargePath}/simulated-payment`, post({}))).status, 409);

  const event = {
    type: "codi.qr.payment_received", codiQrId: "codi-test",
    transactionId: "transaction-01", amount: 0.01, bankAccountId: "test-account",
    datePaid: Math.floor(Date.now() / 1000),
  };
  const hookPath = "/api/webhooks/pey";
  const signer = new Webhook(hookSecret);
  function webhook(data, valid = true) {
    const id = randomUUID();
    const date = new Date();
    return post(data, {
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(date.getTime() / 1000)),
      "webhook-signature": valid ? signer.sign(id, date, JSON.stringify(data)) : "v1,invalid",
    });
  }
  assert.equal((await req(hookPath, webhook(event, false))).status, 401);
  assert.equal((await req(hookPath, webhook({ ...event, amount: 0.02 }))).status, 422);
  assert.equal((await req(hookPath, webhook({ ...event, bankAccountId: "other-account" }))).status, 422);
  assert.equal((await (await req(chargePath)).json()).status, "pending");
  assert.equal((await req(hookPath, webhook(event))).status, 204);
  assert.equal((await req(hookPath, webhook(event))).status, 204);
  assert.equal((await req(hookPath, webhook({ ...event, transactionId: "transaction-02" }))).status, 409);
  const paid = await (await req(chargePath)).json();
  assert.equal(paid.status, "paid");
  assert.equal(paid.mode, "live");
  assert.equal(paid.paidAt, event.datePaid * 1000);
});

test("live mode is disabled on an unconfigured public demo", async (t) => {
  const req = await setup(t);
  const health = await (await req("/api/health")).json();
  assert.deepEqual(health, { ok: true, liveReady: false });
  assert.equal((await req("/api/charges", post({ mode: "live", channel: "pos" }, { "Idempotency-Key": randomUUID() }))).status, 503);
  assert.equal((await req("/api/webhooks/pey", post({}))).status, 503);
});
