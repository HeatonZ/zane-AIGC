import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchHermesWithRetry, isRetryableHermesNetworkError, isRetryableHermesResponse } from "./hermesTransport.js";

function response(status: number) {
  return new Response(JSON.stringify({ status }), { status, headers: { "Content-Type": "application/json" } });
}

test("Hermes transport retries a dropped socket", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }) });
    return response(200);
  }) as typeof fetch;
  try {
    const result = await fetchHermesWithRetry("http://127.0.0.1:8642/v1/models");
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hermes transport retries transient gateway responses", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return response(calls === 1 ? 503 : 200);
  }) as typeof fetch;
  try {
    const result = await fetchHermesWithRetry("http://127.0.0.1:8642/v1/models");
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hermes transport retries common connection failures but not unknown TypeErrors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) });
    return response(200);
  }) as typeof fetch;
  try {
    const result = await fetchHermesWithRetry("http://127.0.0.1:8642/v1/models");
    assert.equal(result.status, 200);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(isRetryableHermesNetworkError(new TypeError("fetch failed")), false);
  assert.equal(isRetryableHermesNetworkError(new DOMException("cancelled", "AbortError")), false);
});

test("Hermes transport can disable network retries for an ambiguous request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }) });
  }) as typeof fetch;
  try {
    await assert.rejects(fetchHermesWithRetry("http://127.0.0.1:8642/v1/chat/completions", { method: "POST" }, { retryNetworkErrors: false }), /fetch failed/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hermes transport skips HTTP retries when the request is not idempotent", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return response(503);
  }) as typeof fetch;
  try {
    const result = await fetchHermesWithRetry("http://127.0.0.1:8642/v1/chat/completions", { method: "POST" }, { retryHttpStatuses: [] });
    assert.equal(result.status, 503);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hermes transport retries only selected transient responses", () => {
  assert.equal(isRetryableHermesResponse(response(401)), false);
  assert.equal(isRetryableHermesResponse(response(503)), true);
});
