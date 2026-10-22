import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Exercise the installed skill exactly as another project would: a separate
// Node process, files outside this repository, and disposable HTTP services.
const helper = fileURLToPath(new URL("../skills/zhiyu-memory/scripts/memory-client.mjs", import.meta.url));
const tokenEnv = "ZHIYU_MEMORY_SKILL_TEST_TOKEN";
const identityToken = "x".repeat(43);
const useCredential = "u".repeat(43);
const namespace = { tenantId: "test-tenant", projectId: "test-project" };
const prepareBody = {
  recall: { scope: "pipeline", query: "release checks", maxBytes: 16384 },
  consumerId: "test-consumer",
  purpose: "test-release",
};

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function fixture(t, options = {}) {
  const root = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, "zhiyu-memory-skill-test-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const request = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        rawBody,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      };
      requests.push(request);
      if (await options.handle?.({ request, res, requests, directory })) return;
      if (req.url === "/v1/capabilities") {
        sendJson(res, options.capabilities ?? {
          protocolVersion: "general-memory.v1-draft",
          namespace,
          sources: ["test-source"],
          consumers: ["test-consumer"],
          retrieval: { modes: ["keyword", "vector", "hybrid"], defaultMode: "hybrid" },
        });
      } else if (req.url === "/v1/use/prepare") {
        sendJson(res, {
          pack: { namespace, interpretations: [], constraints: [] },
          use: {
            credential: useCredential,
            consumerId: prepareBody.consumerId,
            purpose: prepareBody.purpose,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            packHash: "a".repeat(64),
            semantics: "single_use_no_automatic_retry",
          },
        });
      } else if (req.url === "/v1/use/status") {
        sendJson(res, { state: "outcome_unknown", admissionId: "test-admission", automaticRetry: false });
      } else {
        sendJson(res, { status: "ok", received: request.body });
      }
    } catch {
      if (!res.headersSent) sendJson(res, { code: "fixture_failed" }, 500);
      else res.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = path.join(directory, "profile.json");
  await fs.writeFile(config, JSON.stringify({
    baseUrl: origin,
    tokenEnv,
    expectedNamespace: namespace,
    ...options.profile,
  }));

  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // Recursive cleanup is limited to the exact directory this fixture made.
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), root);
    assert.match(path.basename(resolved), /^zhiyu-memory-skill-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });

  async function run(args, envOverrides = {}) {
    const env = { ...process.env, [tokenEnv]: identityToken, ...envOverrides };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [helper, "--config", config, ...args], {
        cwd: directory,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error("skill_cli_test_timeout")); }, 10000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  async function bodyFile(value, filename = "body.json") {
    const filenamePath = path.join(directory, filename);
    await fs.writeFile(filenamePath, JSON.stringify(value), "utf8");
    return filenamePath;
  }

  async function prepare(filename = "use.json") {
    const useFile = path.join(directory, filename);
    const body = await bodyFile(prepareBody, `prepare-${filename}.json`);
    const result = await run(["prepare", "--body-file", body, "--use-file", useFile]);
    assert.equal(result.code, 0, result.stderr);
    return { result, useFile, ticket: JSON.parse(await fs.readFile(useFile, "utf8")) };
  }

  return { directory, config, origin, requests, run, bodyFile, prepare };
}

function assertFailed(result) {
  assert.notEqual(result.code, 0, `Unexpected success: ${result.stdout}`);
}

function assertNoSecrets(result) {
  for (const secret of [identityToken, useCredential]) {
    assert.equal((result.stdout + result.stderr).includes(secret), false, "CLI exposed a credential");
  }
}

test("capabilities checks the authenticated namespace with GET and Bearer", async (t) => {
  const f = await fixture(t);
  const result = await f.run(["capabilities"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).namespace, namespace);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, "GET");
  assert.equal(f.requests[0].url, "/v1/capabilities");
  assert.equal(f.requests[0].headers.authorization, `Bearer ${identityToken}`);
  assert.equal(f.requests[0].rawBody, "");
});

test("read requests preserve Unicode JSON and use POST with JSON content type", async (t) => {
  const f = await fixture(t);
  const body = { purpose: "current", id: "\u53d1\u5e03\ud83d\ude80", nested: { quote: "\u4e0a\u7ebf\u524d\u8fd0\u884c\u6d4b\u8bd5\u3002\n\u4fdd\u7559\u6362\u884c" } };
  const bodyPath = await f.bodyFile(body);
  const result = await f.run(["request", "/v1/read", "--body-file", bodyPath]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.requests.map(({ method, url }) => [method, url]), [
    ["GET", "/v1/capabilities"], ["POST", "/v1/read"],
  ]);
  const request = f.requests[1];
  assert.match(request.headers["content-type"], /^application\/json(?:;|$)/);
  assert.equal(request.headers.authorization, `Bearer ${identityToken}`);
  assert.deepEqual(request.body, body);
  assert.deepEqual(JSON.parse(result.stdout).received, body);
});

test("namespace mismatch stops the requested POST", async (t) => {
  const f = await fixture(t, { capabilities: { namespace: { ...namespace, projectId: "another-project" } } });
  const body = await f.bodyFile({ scope: "pipeline", query: "release", maxBytes: 512 });
  const result = await f.run(["request", "/v1/recall", "--body-file", body]);
  assertFailed(result);
  assert.equal(f.requests.some(({ method }) => method === "POST"), false);
});

test("installed mode calls only the explicitly supplied project operation", async (t) => {
  const f = await fixture(t, {
    profile: { mode: "installed" },
    capabilities: { protocol: "general-memory.project.http.v1", ...namespace, project: { name: "test-project" } },
  });
  const body = await f.bodyFile({ operation: "host-provided-operation", input: { text: "known operation" } });
  const allowed = await f.run(["request", "/v1/project/call", "--body-file", body]);
  assert.equal(allowed.code, 0, allowed.stderr);
  const refused = await f.run(["request", "/v1/recall", "--body-file", body]);
  assertFailed(refused);
  assert.deepEqual(f.requests.filter(({ method }) => method === "POST").map(({ url }) => url), ["/v1/project/call"]);
});

test("standard mode does not guess standard routes for an installed service", async (t) => {
  const f = await fixture(t, { capabilities: { protocol: "general-memory.project.http.v1", ...namespace, project: {} } });
  const body = await f.bodyFile({ scope: "pipeline", query: "release", maxBytes: 512 });
  const result = await f.run(["request", "/v1/recall", "--body-file", body]);
  assertFailed(result);
  assert.equal(f.requests.some(({ method }) => method === "POST"), false);
});

test("redirects are refused without sending a credential to the destination", async (t) => {
  const destination = await fixture(t);
  const f = await fixture(t, { handle({ res }) {
    res.writeHead(307, { location: destination.origin + "/capture" });
    res.end();
    return true;
  } });
  const result = await f.run(["capabilities"]);
  assertFailed(result);
  assert.equal(f.requests.length, 1);
  assert.equal(destination.requests.length, 0);
  assertNoSecrets(result);
});

test("unsafe service origins fail before any HTTP request", async (t) => {
  const f = await fixture(t);
  for (const baseUrl of [f.origin + "/nested", f.origin + "?token=secret", "http://example.com", "https://user:secret@example.com", "file:///tmp/service"]) {
    await fs.writeFile(f.config, JSON.stringify({ baseUrl, tokenEnv, expectedNamespace: namespace }));
    assertFailed(await f.run(["capabilities"]));
  }
  assert.equal(f.requests.length, 0);
});

test("malformed profile and request JSON fail before any HTTP request", async (t) => {
  const f = await fixture(t);
  const validProfile = await fs.readFile(f.config, "utf8");
  await fs.writeFile(f.config, "{broken");
  assertFailed(await f.run(["capabilities"]));
  await fs.writeFile(f.config, validProfile);
  const body = path.join(f.directory, "malformed.json");
  await fs.writeFile(body, '{"query":');
  assertFailed(await f.run(["request", "/v1/recall", "--body-file", body]));
  assert.equal(f.requests.length, 0);
});

test("missing credentials and incomplete profiles fail without HTTP", async (t) => {
  const f = await fixture(t);
  assertFailed(await f.run(["capabilities"], { [tokenEnv]: undefined }));
  await fs.writeFile(f.config, JSON.stringify({ baseUrl: f.origin, tokenEnv }));
  assertFailed(await f.run(["capabilities"]));
  assert.equal(f.requests.length, 0);
});

test("an upstream failure is reported once without automatic retries", async (t) => {
  const f = await fixture(t, { handle({ request, res }) {
    if (request.url !== "/v1/read") return false;
    sendJson(res, { code: "service_unavailable" }, 503);
    return true;
  } });
  const body = await f.bodyFile({ purpose: "current", id: "test-id" });
  const result = await f.run(["request", "/v1/read", "--body-file", body]);
  assertFailed(result);
  assert.equal(f.requests.filter(({ url }) => url === "/v1/read").length, 1);
});

test("prepare saves a private ticket without printing either credential", async (t) => {
  const f = await fixture(t);
  const { result, useFile, ticket } = await f.prepare();
  assertNoSecrets(result);
  assert.equal(ticket.credential, useCredential);
  assert.equal(ticket.baseUrl, f.origin);
  assert.deepEqual(ticket.namespace, namespace);
  assert.equal(JSON.stringify(ticket).includes(identityToken), false);
  assert.equal((await fs.stat(useFile)).isFile(), true);
  if (process.platform !== "win32") assert.equal((await fs.stat(useFile)).mode & 0o777, 0o600);
  assert.equal(f.requests.filter(({ url }) => url === "/v1/use/prepare").length, 1);
});

test("prepare refuses an existing use file before issuing a new ticket", async (t) => {
  const f = await fixture(t);
  const body = await f.bodyFile(prepareBody);
  const useFile = path.join(f.directory, "existing-use.json");
  await fs.writeFile(useFile, "existing protected state");
  const result = await f.run(["prepare", "--body-file", body, "--use-file", useFile]);
  assertFailed(result);
  assert.equal(await fs.readFile(useFile, "utf8"), "existing protected state");
  assert.equal(f.requests.filter(({ url }) => url === "/v1/use/prepare").length, 0);
});

test("generic requests cannot bypass the protected use-file lifecycle", async (t) => {
  const f = await fixture(t);
  const body = await f.bodyFile({ credential: useCredential, consumerId: "test-consumer", purpose: "test-release" });
  for (const route of ["/v1/use/prepare", "/v1/use/dispatch", "/v1/use/status"]) {
    assertFailed(await f.run(["request", route, "--body-file", body]));
  }
  assert.equal(f.requests.length, 0);
});

test("dispatch records an attempt before POST and cannot retry a 503", async (t) => {
  let useFile, attemptedBeforePost = false;
  const f = await fixture(t, { handle: async ({ request, res }) => {
    if (request.url !== "/v1/use/dispatch") return false;
    attemptedBeforePost = JSON.parse(await fs.readFile(useFile, "utf8")).dispatchAttempted === true;
    sendJson(res, { code: "dispatch_outcome_unknown", admissionId: "test-admission" }, 503);
    return true;
  } });
  ({ useFile } = await f.prepare());
  const first = await f.run(["dispatch", "--use-file", useFile]);
  const second = await f.run(["dispatch", "--use-file", useFile]);
  assertFailed(first);
  assertFailed(second);
  assert.equal(attemptedBeforePost, true);
  const dispatched = f.requests.filter(({ url }) => url === "/v1/use/dispatch");
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].body, {
    credential: useCredential, consumerId: prepareBody.consumerId, purpose: prepareBody.purpose,
  });
  assertNoSecrets(first);
  assertNoSecrets(second);
});

test("dispatch timeout preserves the attempt and never retries automatically", async (t) => {
  const f = await fixture(t, {
    profile: { timeoutMs: 150 },
    handle({ request }) { return request.url === "/v1/use/dispatch"; },
  });
  const { useFile } = await f.prepare();
  const first = await f.run(["dispatch", "--use-file", useFile]);
  assertFailed(first);
  assert.equal(JSON.parse(await fs.readFile(useFile, "utf8")).dispatchAttempted, true);
  assertFailed(await f.run(["dispatch", "--use-file", useFile]));
  assert.equal(f.requests.filter(({ url }) => url === "/v1/use/dispatch").length, 1);
});

test("two concurrent CLI processes make at most one dispatch attempt", async (t) => {
  const f = await fixture(t);
  const { useFile } = await f.prepare();
  const results = await Promise.all([
    f.run(["dispatch", "--use-file", useFile]),
    f.run(["dispatch", "--use-file", useFile]),
  ]);
  assert.equal(results.filter(({ code }) => code === 0).length, 1);
  assert.equal(f.requests.filter(({ url }) => url === "/v1/use/dispatch").length, 1);
  assert.equal(JSON.parse(await fs.readFile(useFile, "utf8")).dispatchAttempted, true);
});

test("status reconciles the original ticket without issuing or dispatching again", async (t) => {
  const f = await fixture(t, { handle({ request, res }) {
    if (request.url !== "/v1/use/dispatch") return false;
    sendJson(res, { code: "dispatch_outcome_unknown", admissionId: "test-admission" }, 503);
    return true;
  } });
  const { useFile } = await f.prepare();
  assertFailed(await f.run(["dispatch", "--use-file", useFile]));
  const result = await f.run(["status", "--use-file", useFile]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, "outcome_unknown");
  assertNoSecrets(result);
  const statusRequests = f.requests.filter(({ url }) => url === "/v1/use/status");
  assert.equal(statusRequests.length, 1);
  assert.deepEqual(statusRequests[0].body, {
    credential: useCredential, consumerId: prepareBody.consumerId, purpose: prepareBody.purpose,
  });
  assert.equal(f.requests.filter(({ url }) => url === "/v1/use/prepare").length, 1);
  assert.equal(f.requests.filter(({ url }) => url === "/v1/use/dispatch").length, 1);
});

test("a saved ticket cannot be moved to a different origin or namespace", async (t) => {
  const f = await fixture(t);
  const { useFile, ticket } = await f.prepare();
  for (const changed of [
    { ...ticket, baseUrl: "http://127.0.0.1:1" },
    { ...ticket, namespace: { ...namespace, projectId: "another-project" } },
  ]) {
    await fs.writeFile(useFile, JSON.stringify(changed));
    assertFailed(await f.run(["dispatch", "--use-file", useFile]));
    assertFailed(await f.run(["status", "--use-file", useFile]));
  }
  assert.equal(f.requests.filter(({ url }) => ["/v1/use/dispatch", "/v1/use/status"].includes(url)).length, 0);
});

test("untrusted upstream errors cannot expose identity or use credentials", async (t) => {
  let responseCode = "upstream_failed";
  const f = await fixture(t, { handle({ request, res }) {
    if (request.url !== "/v1/read") return false;
    sendJson(res, {
      code: responseCode,
      message: `Bearer ${identityToken} ${useCredential}`,
      admissionId: identityToken,
      details: { credential: useCredential },
    }, 503);
    return true;
  } });
  const body = await f.bodyFile({ purpose: "current", id: "test-id" });
  for (responseCode of ["upstream_failed", identityToken]) {
    const result = await f.run(["request", "/v1/read", "--body-file", body]);
    assertFailed(result);
    assertNoSecrets(result);
  }
});
