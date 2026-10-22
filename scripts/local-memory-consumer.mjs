#!/usr/bin/env node
// Synthetic local delivery sink: no model calls, business actions, or Pack logs.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.env.LOCAL_MEMORY_CONSUMER_PORT || process.argv[2] || 3643);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid consumer port");
const maxBytes = 256 * 1024;
const send = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ready: true, service: "zhiyu-local-test-consumer", synthetic: true });
    return;
  }
  if (req.method !== "POST" || req.url !== "/model") {
    req.resume();
    send(res, 404, { error: "Endpoint not found" });
    return;
  }
  if (Number(req.headers["content-length"]) > maxBytes) {
    req.resume();
    send(res, 413, { error: "Request body exceeds 256 KiB" });
    return;
  }
  const chunks = [];
  let bytes = 0;
  let rejected = false;
  req.on("error", () => { if (!res.writableEnded) send(res, 400, { error: "Request failed" }); });
  req.on("data", (chunk) => {
    bytes += chunk.length;
    if (rejected) return;
    if (bytes > maxBytes) {
      rejected = true;
      chunks.length = 0;
      send(res, 413, { error: "Request body exceeds 256 KiB" });
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (rejected) return;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body === null || typeof body !== "object" || Array.isArray(body)) throw Error();
    } catch {
      send(res, 400, { error: "Request body must be a JSON object" });
      return;
    }
    const receiptId = randomUUID();
    console.log(JSON.stringify({ receiptId, bytes, synthetic: true, businessActionExecuted: false }));
    send(res, 200, { acknowledged: true, receiptId, synthetic: true });
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({
  event: "local-consumer-ready", host: "127.0.0.1", port, synthetic: true,
})));
server.on("error", () => {
  console.error(JSON.stringify({ event: "local-consumer-start-failed" }));
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  server.close();
  server.closeIdleConnections();
});
