#!/usr/bin/env node

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const adminToken = process.env.ADMIN_TOKEN ?? "dev-admin-token";
const runId = process.env.RUN_ID ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : {};
  return { status: response.status, body };
}

async function jsonRequest(path, body, headers = {}) {
  return request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function userHeaders(userId) {
  return {
    authorization: `Bearer ${userId}`,
    "x-correlation-id": `${runId}-${userId}`
  };
}

function adminHeaders() {
  return {
    "x-admin-token": adminToken,
    "x-correlation-id": `${runId}-admin`
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function seed(userId, balancePaise) {
  const result = await jsonRequest(
    "/admin/seed",
    { user_id: userId, balance_paise: balancePaise },
    adminHeaders()
  );
  assert(result.status === 200, `seed failed for ${userId}: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function getWallet(walletId, userId = "probe-reader") {
  const result = await request(`/wallets/${walletId}`, {
    headers: userHeaders(userId)
  });
  assert(result.status === 200, `wallet read failed: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function createWallet(userId) {
  const result = await request("/wallets", {
    method: "POST",
    headers: userHeaders(userId)
  });
  assert(result.status === 200, `wallet create failed: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

async function transfer(body, userId = "probe-transfer") {
  return jsonRequest("/transfers", body, userHeaders(userId));
}

async function gateGetOrCreate() {
  const userId = `race-${runId}`;
  const responses = await Promise.all(Array.from({ length: 50 }, () => createWallet(userId)));
  const walletIds = new Set(responses.map((wallet) => wallet.wallet_id));
  assert(walletIds.size === 1, `expected 1 wallet id, got ${walletIds.size}`);
  console.log(JSON.stringify({ gate: "get_or_create", ok: true, wallet_id: responses[0].wallet_id }));
}

async function gateIdempotency() {
  const from = await seed(`idem-from-${runId}`, 10_000);
  const to = await seed(`idem-to-${runId}`, 0);
  const body = {
    from: from.wallet_id,
    to: to.wallet_id,
    amount_paise: 1_000,
    idempotency_key: `idem-${runId}`
  };

  const responses = await Promise.all(Array.from({ length: 30 }, () => transfer(body, `idem-from-${runId}`)));
  assert(responses.every((response) => response.status === 200), `idempotent storm had non-200 response`);

  const serialized = responses.map((response) => JSON.stringify(response.body));
  assert(new Set(serialized).size === 1, "idempotent storm returned different bodies");

  const fromAfter = await getWallet(from.wallet_id);
  const toAfter = await getWallet(to.wallet_id);
  assert(fromAfter.balance_paise === 9_000, `expected sender 9000, got ${fromAfter.balance_paise}`);
  assert(toAfter.balance_paise === 1_000, `expected recipient 1000, got ${toAfter.balance_paise}`);

  const conflict = await transfer({ ...body, amount_paise: 2_000 }, `idem-from-${runId}`);
  assert(conflict.status === 409, `expected same-key different-body 409, got ${conflict.status}`);

  console.log(JSON.stringify({ gate: "idempotency", ok: true, transfer_id: responses[0].body.transfer_id }));
}

async function gateConservation() {
  const wallets = await Promise.all(
    Array.from({ length: 4 }, (_, index) => seed(`contend-${index}-${runId}`, 50_000))
  );
  const before = await Promise.all(wallets.map((wallet) => getWallet(wallet.wallet_id)));
  const beforeTotal = before.reduce((sum, wallet) => sum + wallet.balance_paise, 0);

  const requests = [];
  for (let index = 0; index < 200; index += 1) {
    const fromIndex = index % wallets.length;
    const toIndex = (index + 1 + (index % 2)) % wallets.length;
    const amount = index % 17 === 0 ? 1_000_000 : 250 + (index % 11) * 25;
    requests.push(
      transfer(
        {
          from: wallets[fromIndex].wallet_id,
          to: wallets[toIndex].wallet_id,
          amount_paise: amount,
          idempotency_key: `contend-${runId}-${index}`
        },
        wallets[fromIndex].user_id
      )
    );
  }

  const responses = await Promise.all(requests);
  assert(responses.every((response) => response.status === 200), "contention transfer returned non-200");
  assert(
    responses.some((response) => response.body.status === "declined_insufficient_funds"),
    "expected at least one insufficient-funds decline"
  );

  const after = await Promise.all(wallets.map((wallet) => getWallet(wallet.wallet_id)));
  const afterTotal = after.reduce((sum, wallet) => sum + wallet.balance_paise, 0);
  assert(beforeTotal === afterTotal, `total changed from ${beforeTotal} to ${afterTotal}`);
  assert(after.every((wallet) => wallet.balance_paise >= 0), "negative wallet balance found");

  console.log(JSON.stringify({ gate: "conservation", ok: true, before_total: beforeTotal, after_total: afterTotal }));
}

async function main() {
  console.log(JSON.stringify({ base_url: baseUrl, run_id: runId }));
  await gateGetOrCreate();
  await gateIdempotency();
  await gateConservation();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
