#!/usr/bin/env node
// Real local CPU embeddings. The first launch downloads model weights; submitted
// text is processed by the local ONNX runtime and is never sent to the model host.
// Model: https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2
import http from "node:http";
import { availableParallelism } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const ALIAS = "local-multilingual-minilm";
const DIMENSIONS = 384;
const MAX_BODY = 256 * 1024;
const MAX_INPUTS = 32;
const MAX_TEXT_LENGTH = 12_000;
const cacheDir = resolve(root, process.env.EMBEDDING_CACHE_DIR || ".runtime/embedding/cache");
const port = Number(process.env.LOCAL_EMBEDDING_PORT || 11434);
const downloadOnly = process.argv.includes("--download-only");
if (process.argv.slice(2).some((arg) => arg !== "--download-only")) {
  throw new Error("Usage: node scripts/local-embedding-server.mjs [--download-only]");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("LOCAL_EMBEDDING_PORT must be a valid TCP port");
}

const runtimePath = resolve(root,
  ".runtime/embedding/node_modules/@huggingface/transformers/dist/transformers.node.mjs");
let extractor;
let server;
let queue = Promise.resolve();
let stopping = false;
const progressState = new Map();

function reportProgress(event) {
  const key = String(event.file || "model").split(/[\\/]/).at(-1);
  const percent = Number.isFinite(event.progress)
    ? Math.min(100, Math.floor(event.progress / 20) * 20) : undefined;
  const state = `${event.status}:${percent ?? ""}`;
  if (progressState.get(key) === state) return;
  progressState.set(key, state);
  console.log(JSON.stringify({ event: "model-download", file: key,
    status: event.status, ...(percent !== undefined ? { percent } : {}) }));
}

function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function error(res, status, message, type = "invalid_request_error") {
  json(res, status, { error: { message, type } });
}

async function readBody(req) {
  const length = Number(req.headers["content-length"]);
  if (Number.isFinite(length) && length > MAX_BODY) {
    req.resume();
    throw Object.assign(new Error("Request body exceeds 256 KiB"), { status: 413 });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) {
      req.resume();
      throw Object.assign(new Error("Request body exceeds 256 KiB"), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

function parseInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }
  if (body.model !== MODEL && body.model !== ALIAS) {
    throw new Error(`model must be ${MODEL} or ${ALIAS}`);
  }
  if (body.encoding_format !== undefined && body.encoding_format !== "float") {
    throw new Error("Only encoding_format: float is supported");
  }
  if (body.dimensions !== undefined && body.dimensions !== DIMENSIONS) {
    throw new Error(`This model produces ${DIMENSIONS} dimensions`);
  }
  const input = typeof body.input === "string" ? [body.input] : body.input;
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_INPUTS) {
    throw new Error(`input must be text or an array of 1 to ${MAX_INPUTS} texts`);
  }
  if (input.some((text) => typeof text !== "string" || !text.trim()
    || text.length > MAX_TEXT_LENGTH)) {
    throw new Error(`Each input must be nonempty text of at most ${MAX_TEXT_LENGTH} characters`);
  }
  return input;
}

async function embed(input) {
  const output = await extractor(input, { pooling: "mean", normalize: true });
  try {
    const embeddings = output.tolist();
    if (embeddings.length !== input.length || embeddings.some((vector) =>
      !Array.isArray(vector) || vector.length !== DIMENSIONS
      || vector.some((value) => !Number.isFinite(value)))) {
      throw new Error("Invalid embedding output");
    }
    return embeddings;
  } finally {
    output.dispose?.();
  }
}

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ready: !stopping, model: MODEL, dimensions: DIMENSIONS,
      runtime: "transformers.js/onnxruntime-node", local: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    json(res, 200, { object: "list", data: [
      { id: MODEL, object: "model", owned_by: "local" },
      { id: ALIAS, object: "model", owned_by: "local" },
    ] });
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/v1/embeddings") {
    error(res, 404, "Endpoint not found");
    return;
  }
  if (stopping) {
    error(res, 503, "Embedding server is shutting down", "server_error");
    return;
  }
  let body;
  let input;
  try {
    body = await readBody(req);
    input = parseInput(body);
  } catch (cause) {
    error(res, cause.status || 400, cause.message);
    return;
  }
  const pending = queue.then(() => embed(input));
  queue = pending.catch(() => {});
  try {
    const embeddings = await pending;
    json(res, 200, { object: "list", model: body.model,
      data: embeddings.map((embedding, index) => ({ object: "embedding", index, embedding })) });
  } catch {
    // Deliberately omit model errors, which may contain submitted text.
    error(res, 500, "Local embedding inference failed", "server_error");
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (server?.listening) {
    const closed = new Promise((resolveClose) => server.close(resolveClose));
    server.closeIdleConnections();
    await closed;
  }
  await queue;
  await extractor?.dispose();
  console.log(JSON.stringify({ event: "embedding-stopped" }));
}

try {
  const { pipeline, env } = await import(pathToFileURL(runtimePath).href);
  env.cacheDir = cacheDir;
  if (process.env.HF_ENDPOINT) {
    const host = new URL(process.env.HF_ENDPOINT);
    if (host.protocol !== "https:" || host.username || host.password || host.search || host.hash) {
      throw new Error("HF_ENDPOINT must be an HTTPS URL without credentials, query, or fragment");
    }
    env.remoteHost = host.href.endsWith("/") ? host.href : `${host.href}/`;
  }
  // ONNX Runtime Node sessions use these settings, rather than WASM options.
  const requestedThreads = Number(process.env.LOCAL_EMBEDDING_THREADS || 4);
  const numThreads = Math.max(1, Math.min(4, availableParallelism(),
    Number.isInteger(requestedThreads) ? requestedThreads : 4));
  extractor = await pipeline("feature-extraction", MODEL, {
    dtype: "q8", device: "cpu", cache_dir: cacheDir,
    session_options: { intraOpNumThreads: numThreads, interOpNumThreads: 1 },
    progress_callback: reportProgress,
  });
  if (downloadOnly) {
    // Warm the same inference path used by requests, with a non-sensitive literal.
    await embed(["local embedding readiness"]);
    await extractor.dispose();
    console.log(JSON.stringify({ event: "model-cached", model: MODEL,
      dimensions: DIMENSIONS, cacheDir, local: true }));
  } else {
    // All future submitted text is served from the already-loaded local model.
    env.allowRemoteModels = false;
    server = http.createServer((req, res) => {
      handle(req, res).catch(() => error(res, 500, "Request failed", "server_error"));
    });
    server.requestTimeout = 120_000;
    server.headersTimeout = 10_000;
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, "127.0.0.1", resolveListen);
    });
    console.log(JSON.stringify({ event: "embedding-ready", host: "127.0.0.1", port,
      model: MODEL, dimensions: DIMENSIONS, numThreads, local: true }));
    process.once("SIGINT", () => { shutdown().catch(() => { process.exitCode = 1; }); });
    process.once("SIGTERM", () => { shutdown().catch(() => { process.exitCode = 1; }); });
  }
} catch {
  // Avoid logging runtime stack traces or configured remote-host credentials.
  console.error(JSON.stringify({ event: "embedding-start-failed",
    message: "Could not load the local embedding runtime/model or bind its loopback port" }));
  await extractor?.dispose();
  process.exitCode = 1;
}
