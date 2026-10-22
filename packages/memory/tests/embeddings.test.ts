import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryError } from "../src/contracts";
import { createHttpEmbeddingProvider, embedTexts, normalizeEmbedding, type EmbeddingProvider } from "../src/embeddings";
import { embeddingFromEnvironment } from "../../../apps/service/embedding";

async function withServer(handler: RequestListener, run: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function provider(url: string, extra = {}) {
  return createHttpEmbeddingProvider({ url, model: "test-embedding", dimensions: 3, ...extra });
}

function isMemoryError(code: string, status: number) {
  return (error: unknown) => error instanceof MemoryError && error.code === code && error.status === status;
}

test("normalization rejects malformed vectors and remains stable for extreme finite components", () => {
  for (const input of [null, "vector", [], [1, 2], [0, 0, 0], [NaN, 1, 2], [Infinity, 1, 2], [1, "2", 3], new Array(3)]) {
    assert.throws(() => normalizeEmbedding(input, 3), isMemoryError("embedding_invalid_response", 502));
  }
  for (const input of [[Number.MAX_VALUE, Number.MAX_VALUE, 0], [Number.MIN_VALUE, Number.MIN_VALUE, 0]]) {
    const result = normalizeEmbedding(input, 3);
    assert.ok(result.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...result) - 1) < 1e-14);
    assert.ok(Math.abs(result[0] - Math.SQRT1_2) < 1e-14);
  }
  assert.deepEqual(normalizeEmbedding([3, 4, 0], 3), [0.6, 0.8, 0]);
});

test("embedTexts validates custom providers and sanitizes unexpected provider errors", async () => {
  const base = { id: "test", dimensions: 3 };
  const invalid = [[], [[0, 0, 0]], [[1, 2]], [[1, 0, 0], [0, 1, 0]]];
  for (const vectors of invalid) {
    await assert.rejects(embedTexts({ ...base, embed: async () => vectors }, ["one"]), isMemoryError("embedding_invalid_response", 502));
  }
  await assert.rejects(embedTexts({ ...base, embed: async () => { throw Error("secret API key and source text"); } }, ["one"]), (error: unknown) => {
    assert.ok(isMemoryError("embedding_unavailable", 503)(error));
    assert.equal((error as Error).message, "Embedding service unavailable");
    return true;
  });
  const expected = new MemoryError("embedding_invalid_response", 502, "Invalid embedding response");
  await assert.rejects(embedTexts({ ...base, embed: async () => { throw expected; } }, ["one"]), (error) => error === expected);
  const good: EmbeddingProvider = { ...base, embed: async () => [[3, 4, 0]] };
  assert.deepEqual(await embedTexts(good, ["one"]), [[0.6, 0.8, 0]]);
  assert.deepEqual(await embedTexts({ ...base, embed: async () => { throw Error("should not call"); } }, []), []);
});

test("HTTP provider posts the exact protocol and authorization, reorders and normalizes indexed vectors", async () => {
  let request: unknown;
  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/embeddings");
    assert.equal(req.headers.authorization, "Bearer private-key");
    assert.equal(req.headers["content-type"], "application/json");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 4, 0] }, { index: 0, embedding: [3, 0, 0] }] }));
  }, async (url) => {
    assert.deepEqual(await provider(url, { apiKey: "private-key" }).embed(["first", "second"]), [[1, 0, 0], [0, 1, 0]]);
  });
  assert.deepEqual(request, { model: "test-embedding", input: ["first", "second"], encoding_format: "float" });
});

test("HTTP provider rejects missing, duplicate, invalid and out-of-range indices, counts and vectors", async () => {
  const valid = { index: 0, embedding: [1, 0, 0] };
  const bodies = [
    {}, { data: null }, { data: [valid] }, { data: [valid, valid] },
    { data: [valid, { index: 2, embedding: [0, 1, 0] }] },
    { data: [valid, { index: -1, embedding: [0, 1, 0] }] },
    { data: [valid, { index: 0.5, embedding: [0, 1, 0] }] },
    { data: [valid, { embedding: [0, 1, 0] }] },
    { data: [valid, { index: 1, embedding: [0, 0, 0] }] },
    { data: [valid, { index: 1, embedding: [1, 2] }] },
    { data: [valid, { index: 1, embedding: [null, 1, 0] }] },
  ];
  let next = 0;
  await withServer((_req, res) => res.end(JSON.stringify(bodies[next++])), async (url) => {
    for (const _body of bodies) {
      await assert.rejects(provider(url).embed(["first", "second"]), isMemoryError("embedding_invalid_response", 502));
    }
  });
});

test("HTTP provider sanitizes authorization and upstream errors without returning the body", async () => {
  await withServer((_req, res) => {
    res.statusCode = 401;
    res.end("private-key source-document provider-stack-trace");
  }, async (url) => {
    await assert.rejects(provider(url).embed(["one"]), (error: unknown) => {
      assert.ok(isMemoryError("embedding_unavailable", 503)(error));
      assert.equal((error as Error).message, "Embedding service unavailable");
      return true;
    });
  });
});

test("HTTP provider forbids redirects", async () => {
  let requests = 0;
  await withServer((req, res) => {
    requests++;
    if (req.url === "/v1/embeddings") {
      res.writeHead(307, { location: "/redirected" });
      res.end();
    } else {
      res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
    }
  }, async (url) => {
    await assert.rejects(provider(url).embed(["one"]), isMemoryError("embedding_unavailable", 503));
  });
  assert.equal(requests, 1);
});

test("HTTP provider timeout covers both response headers and response body reading", async () => {
  for (const headersSent of [false, true]) {
    await withServer((_req, res) => {
      if (headersSent) {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"data":[');
      }
    }, async (url) => {
      await assert.rejects(provider(url, { timeoutMs: 50 }).embed(["one"]), isMemoryError("embedding_unavailable", 503));
    });
  }
});

test("HTTP provider bounds declared and chunked response sizes", async () => {
  for (const declared of [true, false]) {
    await withServer((_req, res) => {
      if (declared) {
        res.setHeader("content-length", 8 * 1024 * 1024 + 1);
        res.end("x");
      } else {
        res.setHeader("transfer-encoding", "chunked");
        res.end("x".repeat(8 * 1024 * 1024 + 1));
      }
    }, async (url) => {
      await assert.rejects(provider(url).embed(["one"]), isMemoryError("embedding_invalid_response", 502));
    });
  }
});

test("HTTP provider rejects malformed JSON and invalid UTF-8", async () => {
  for (const bytes of [Buffer.from("not JSON"), Buffer.from([0xff, 0xfe])]) {
    await withServer((_req, res) => res.end(bytes), async (url) => {
      await assert.rejects(provider(url).embed(["one"]), isMemoryError("embedding_invalid_response", 502));
    });
  }
});

test("provider configuration is validated before making requests and identity excludes credentials", () => {
  for (const url of ["bad-url", "file:///tmp/model", "http://example.com/v1/embeddings", "http://192.168.1.1/v1/embeddings", "https://user:password@example.com/v1/embeddings", "https://example.com/v1/embeddings?token=secret", "https://example.com/v1/embeddings#hash", "https://example.com/v1/embeddings?"]) {
    assert.throws(() => provider(url), isMemoryError("embedding_configuration_invalid", 500));
  }
  for (const dimensions of [0, -1, 1.5, Infinity, 65537]) {
    assert.throws(() => provider("https://example.com/v1/embeddings", { dimensions }), isMemoryError("embedding_configuration_invalid", 500));
  }
  for (const extra of [{ model: " " }, { timeoutMs: 0 }, { timeoutMs: 60001 }, { timeoutMs: NaN }, { apiKey: "" }, { apiKey: "injected\r\nheader" }]) {
    assert.throws(() => provider("https://example.com/v1/embeddings", extra), isMemoryError("embedding_configuration_invalid", 500));
  }
  const url = "https://example.com/v1/embeddings";
  assert.equal(provider(url, { apiKey: "first-secret" }).id, provider(url, { apiKey: "second-secret" }).id);
  assert.notEqual(provider(url).id, provider(url, { model: "other" }).id);
  assert.notEqual(provider(url).id, provider(url, { dimensions: 4 }).id);
  assert.doesNotMatch(provider(url, { apiKey: "first-secret" }).id, /first-secret|example/);
  assert.doesNotThrow(() => provider("http://[::1]:11434/v1/embeddings"));
  assert.doesNotThrow(() => provider("http://localhost:11434/v1/embeddings"));
});

test("environment configuration is opt-in and rejects partial or malformed configurations", () => {
  assert.equal(embeddingFromEnvironment({}), undefined);
  const complete = { MEMORY_EMBEDDING_URL: "http://127.0.0.1:11434/v1/embeddings", MEMORY_EMBEDDING_MODEL: "embedding-model", MEMORY_EMBEDDING_DIMENSIONS: "768" };
  const configured = embeddingFromEnvironment(complete)!;
  assert.equal(configured.defaultMode, "hybrid");
  assert.equal(configured.minSimilarity, 0.3);
  assert.equal(configured.provider.dimensions, 768);
  for (const env of [{ MEMORY_EMBEDDING_API_KEY: "secret" }, { MEMORY_EMBEDDING_URL: complete.MEMORY_EMBEDDING_URL }, { ...complete, MEMORY_EMBEDDING_MODEL: "" }, { ...complete, MEMORY_EMBEDDING_DIMENSIONS: "3.5" }, { ...complete, MEMORY_EMBEDDING_DIMENSIONS: "-3" }, { ...complete, MEMORY_EMBEDDING_DIMENSIONS: "" }]) {
    assert.throws(() => embeddingFromEnvironment(env), isMemoryError("embedding_configuration_invalid", 500));
  }
});
