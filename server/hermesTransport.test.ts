import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchHermesWithRetry, HermesRunEndpointUnavailableError, isRetryableHermesNetworkError, isRetryableHermesResponse, requestHermesRun } from "./hermesTransport.js";

function response(status: number, body: unknown = { status }) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

test("Hermes transport honors a larger configurable retry budget", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls <= 4) throw new TypeError("fetch failed", { cause: Object.assign(new Error("gateway reloading"), { code: "ECONNRESET" }) });
    return response(200);
  }) as typeof fetch;
  try {
    const result = await fetchHermesWithRetry("http://127.0.0.1:8642/v1/models", {}, {
      retryAttempts: 4,
      retryInitialDelayMs: 0,
      retryMaxDelayMs: 0,
    });
    assert.equal(result.status, 200);
    assert.equal(calls, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("Hermes durable runs retry admission with the same idempotency key and poll to completion", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let admissionAttempts = 0;
  let statusCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/runs")) {
      admissionAttempts += 1;
      assert.equal(new Headers(init?.headers).get("Idempotency-Key"), "test-run-key");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "hermes-agent",
        input: [{ role: "user", content: "hello" }],
      });
      if (admissionAttempts === 1) throw new TypeError("fetch failed");
      return response(202, { run_id: "run_test", status: "started", replayed: admissionAttempts > 2 });
    }
    assert.ok(url.endsWith("/v1/runs/run_test"));
    statusCalls += 1;
    return statusCalls === 1
      ? response(200, { run_id: "run_test", status: "running" })
      : response(200, { run_id: "run_test", status: "completed", output: "{\"ok\":true}" });
  }) as typeof fetch;
  try {
    const output = await requestHermesRun({
      startUrl: "http://127.0.0.1:8642/v1/runs",
      statusUrl: (runId) => `http://127.0.0.1:8642/v1/runs/${runId}`,
      headers: { Authorization: "Bearer test-key" },
      body: { model: "hermes-agent", input: [{ role: "user", content: "hello" }] },
      idempotencyKey: "test-run-key",
      timeoutMs: 2_000,
      pollIntervalMs: 0,
    });
    assert.equal(output, "{\"ok\":true}");
    assert.equal(admissionAttempts, 2);
    assert.equal(statusCalls, 2);
    assert.deepEqual(calls, [
      "http://127.0.0.1:8642/v1/runs",
      "http://127.0.0.1:8642/v1/runs",
      "http://127.0.0.1:8642/v1/runs/run_test",
      "http://127.0.0.1:8642/v1/runs/run_test",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hermes durable runs identify an unsupported endpoint for legacy fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response(404, { error: { message: "Not Found" } })) as typeof fetch;
  try {
    await assert.rejects(
      requestHermesRun({
        startUrl: "http://127.0.0.1:8642/v1/runs",
        statusUrl: (runId) => `http://127.0.0.1:8642/v1/runs/${runId}`,
        headers: { Authorization: "Bearer test-key" },
        body: { model: "hermes-agent", input: "hello" },
        idempotencyKey: "test-run-key",
        timeoutMs: 2_000,
      }),
      (error) => error instanceof HermesRunEndpointUnavailableError && error.status === 404,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Hermes transport retries only selected transient responses", () => {
  assert.equal(isRetryableHermesResponse(response(401)), false);
  assert.equal(isRetryableHermesResponse(response(503)), true);
});
