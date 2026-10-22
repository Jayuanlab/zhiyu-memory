#!/usr/bin/env node
// Self-contained transport for the Zhiyu Memory skill. Requires Node.js 22+.
import { open, lstat, rename, unlink } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const STANDARD_BYTES = 256 * 1024;
const INSTALLED_BYTES = 1024 * 1024;
const RESPONSE_BYTES = 8 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const STANDARD_ROUTES = new Set([
  "/v1/records/commands", "/v1/records/query", "/v1/commands",
  "/v1/read", "/v1/evidence", "/v1/recall",
]);
const STATUS_RECOVERY = Object.freeze({
  command: "status", route: "/v1/use/status", automaticRetry: false,
});

class ClientError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) { throw new ClientError(code, details); }
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, allowed, required = allowed) {
  return object(value) && Object.keys(value).every(key => allowed.includes(key)) &&
    required.every(key => Object.hasOwn(value, key));
}
function text(value, maximum = 200) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function namespace(value) {
  return exactKeys(value, ["tenantId", "projectId"]) &&
    text(value.tenantId) && text(value.projectId);
}
function sameNamespace(left, right) {
  return left.tenantId === right.tenantId && left.projectId === right.projectId;
}

export function serviceOrigin(value) {
  if (typeof value !== "string" || /[\s\\]/u.test(value) ||
      !/^https?:\/\/[^/?#]+\/?$/.test(value)) fail("invalid_service_origin");
  let url;
  try { url = new URL(value); } catch { fail("invalid_service_origin"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
    fail("invalid_service_origin");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = (isIP(host) === 4 && host.startsWith("127.")) || host === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    fail("tls_required");
  return url.origin;
}

export function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 3 || argv[0] !== "--config" ||
      !text(argv[1], 32768) || argv[1].startsWith("--")) fail("invalid_arguments");
  const config = argv[1];
  const command = argv[2];
  const tail = argv.slice(3);
  if (command === "capabilities") {
    if (tail.length) fail("invalid_arguments");
    return { config, command };
  }
  if (!["request", "prepare", "dispatch", "status"].includes(command))
    fail("invalid_arguments");
  let route;
  if (command === "request") {
    route = tail.shift();
    if (typeof route !== "string") fail("invalid_arguments");
  }
  const allowed = command === "request" ? ["--body-file"] :
    command === "prepare" ? ["--body-file", "--use-file"] : ["--use-file"];
  const flags = {};
  if (tail.length !== allowed.length * 2) fail("invalid_arguments");
  for (let index = 0; index < tail.length; index += 2) {
    const flag = tail[index], value = tail[index + 1];
    if (!allowed.includes(flag) || Object.hasOwn(flags, flag) ||
        !text(value, 32768) || value.startsWith("--")) fail("invalid_arguments");
    flags[flag] = value;
  }
  return { config, command, route, bodyFile: flags["--body-file"], useFile: flags["--use-file"] };
}

function decodeJson(bytes, code = "invalid_json") {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!object(value)) fail(code);
    return value;
  } catch { fail(code); }
}

async function readJson(file, maximum, code = "invalid_json") {
  let handle;
  try {
    handle = await open(file, "r");
    if (!(await handle.stat()).isFile()) fail(code);
    const chunks = [];
    let length = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      length += bytesRead;
      if (length > maximum) fail(code === "invalid_json" ? "request_too_large" : code);
    }
    const value = decodeJson(Buffer.concat(chunks, length), code);
    // JSON number normalization can make a parsed request larger than its source file.
    if (code === "invalid_json" && Buffer.byteLength(JSON.stringify(value), "utf8") > maximum)
      fail("request_too_large");
    return value;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    fail(code === "invalid_json" ? "input_file_unavailable" : code);
  } finally { await handle?.close().catch(() => {}); }
}

export async function readProfile(file) {
  const value = await readJson(file, STANDARD_BYTES, "invalid_profile");
  if (!exactKeys(value, ["baseUrl", "tokenEnv", "expectedNamespace", "mode", "timeoutMs"],
    ["baseUrl", "tokenEnv", "expectedNamespace"]) ||
      !namespace(value.expectedNamespace) || typeof value.tokenEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.tokenEnv) || value.tokenEnv.length > 200 ||
      (Object.hasOwn(value, "mode") && !["standard", "installed"].includes(value.mode)) ||
      (Object.hasOwn(value, "timeoutMs") && (!Number.isInteger(value.timeoutMs) ||
        value.timeoutMs < 1 || value.timeoutMs > 120000))) fail("invalid_profile");
  return {
    baseUrl: serviceOrigin(value.baseUrl), tokenEnv: value.tokenEnv,
    expectedNamespace: value.expectedNamespace, mode: value.mode ?? "standard",
    timeoutMs: value.timeoutMs ?? 20000,
  };
}

function redact(value, secrets) {
  if (typeof value === "string") {
    for (const secret of secrets) if (secret) value = value.replaceAll(secret, "[REDACTED]");
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    redact(key, secrets), /^(credential|token|authorization|access[_-]?token|refresh[_-]?token)$/i.test(key)
      ? "[REDACTED]" : redact(item, secrets),
  ]));
  return value;
}

function upstreamError(data, status, secrets) {
  const candidate = typeof data?.code === "string" ? data.code : "";
  const safeCode = /^[a-z][a-z0-9_]{0,79}$/.test(candidate) &&
    ![...secrets].some(secret => secret && candidate.includes(secret));
  const details = { httpStatus: status };
  // The service generates UUID admission IDs. Never echo arbitrary upstream strings.
  if (typeof data?.admissionId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.admissionId) &&
      ![...secrets].some(secret => secret && data.admissionId.includes(secret)))
    details.admissionId = data.admissionId;
  return new ClientError(safeCode ? candidate : "http_error", details);
}

async function http(profile, token, route, input, secrets, fetchImpl) {
  const body = input === undefined ? undefined : JSON.stringify(input);
  if (body !== undefined && Buffer.byteLength(body, "utf8") >
      (profile.mode === "installed" ? INSTALLED_BYTES : STANDARD_BYTES)) fail("request_too_large");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), profile.timeoutMs);
  let response;
  try {
    response = await fetchImpl(new URL(route, profile.baseUrl), {
      method: input === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      redirect: "manual", signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) fail("redirect_denied", { httpStatus: response.status });
    const reader = response.body?.getReader();
    const chunks = [];
    let length = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > RESPONSE_BYTES) {
            controller.abort();
            fail("response_too_large", { httpStatus: response.status });
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    const data = decodeJson(Buffer.concat(chunks, length), "invalid_service_response");
    if (!response.ok) throw upstreamError(data, response.status, secrets);
    return data;
  } catch (error) {
    if (error instanceof ClientError) throw error;
    fail(controller.signal.aborted ? "request_timeout" : "request_failed");
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

async function preflight(profile, token, secrets, fetchImpl) {
  const data = await http(profile, token, "/v1/capabilities", undefined, secrets, fetchImpl);
  let actual;
  if (profile.mode === "installed") {
    if (data.protocol !== "general-memory.project.http.v1") fail("service_mode_mismatch");
    actual = { tenantId: data.tenantId, projectId: data.projectId };
  } else {
    if (Object.hasOwn(data, "protocol") || !namespace(data.namespace)) fail("service_mode_mismatch");
    actual = data.namespace;
  }
  if (!namespace(actual) || !sameNamespace(actual, profile.expectedNamespace)) fail("namespace_mismatch");
  return data;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

async function exclusiveFile(file, existsCode) {
  let handle;
  let owned;
  try {
    handle = await open(file, "wx", 0o600);
    owned = { file, handle, identity: await handle.stat() };
    await handle.chmod(0o600);
    return owned;
  } catch (error) {
    if (owned) await closeOwned(owned, true, true);
    else await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") fail(existsCode);
    fail("private_file_unavailable");
  }
}

async function closeOwned(owned, remove = false, onlyEmpty = false) {
  await owned.handle.close().catch(() => {});
  if (!remove) return;
  try {
    const current = await lstat(owned.file);
    if (current.isFile() && sameFile(owned.identity, current) && (!onlyEmpty || current.size === 0))
      await unlink(owned.file);
  } catch { /* Never remove a replacement file or mask the original result. */ }
}

async function saveReservation(owned, value) {
  try {
    const current = await lstat(owned.file);
    if (!current.isFile() || !sameFile(owned.identity, current) || current.size !== 0)
      fail("use_file_changed");
    await owned.handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await owned.handle.sync();
    if (!sameFile(owned.identity, await lstat(owned.file))) fail("use_file_changed");
  } catch (error) {
    if (error instanceof ClientError) throw error;
    fail("use_file_save_failed");
  }
}

function ticket(value, profile) {
  const keys = ["schemaVersion", "baseUrl", "namespace", "credential", "consumerId", "purpose", "expiresAt", "packHash"];
  if (!exactKeys(value, [...keys, "dispatchAttempted"], keys) || value.schemaVersion !== 1 ||
      !namespace(value.namespace) || typeof value.credential !== "string" || !TOKEN.test(value.credential) ||
      !text(value.consumerId) || !text(value.purpose) || !text(value.expiresAt, 100) ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      typeof value.packHash !== "string" || !/^[a-f0-9]{64}$/.test(value.packHash) ||
      (Object.hasOwn(value, "dispatchAttempted") && value.dispatchAttempted !== true)) fail("invalid_use_file");
  let origin;
  try { origin = serviceOrigin(value.baseUrl); } catch { fail("invalid_use_file"); }
  if (origin !== value.baseUrl || origin !== profile.baseUrl ||
      !sameNamespace(value.namespace, profile.expectedNamespace)) fail("use_file_binding_mismatch");
  return value;
}

async function readTicket(file, profile) {
  try {
    if (!(await lstat(file)).isFile()) fail("invalid_use_file");
    return ticket(await readJson(file, STANDARD_BYTES, "invalid_use_file"), profile);
  } catch (error) {
    if (error instanceof ClientError) throw error;
    fail("invalid_use_file");
  }
}

async function markDispatchAttempted(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let owned;
  try {
    owned = await exclusiveFile(temporary, "private_file_unavailable");
    await owned.handle.writeFile(`${JSON.stringify({ ...value, dispatchAttempted: true })}\n`, "utf8");
    await owned.handle.sync();
    await owned.handle.close();
    // Closing both the ticket reader and temporary handle also permits replacement on Windows.
    await rename(temporary, file);
    owned = undefined;
  } catch {
    fail("dispatch_state_save_failed");
  } finally {
    if (owned) await closeOwned(owned, true);
  }
}

function useArguments(value) {
  return { credential: value.credential, consumerId: value.consumerId, purpose: value.purpose };
}

async function run(args, profile, token, secrets, fetchImpl) {
  const call = (route, body) => http(profile, token, route, body, secrets, fetchImpl);
  const discover = () => preflight(profile, token, secrets, fetchImpl);
  if (args.command === "capabilities") return discover();
  if (args.command === "request") {
    const allowed = profile.mode === "installed" ? args.route === "/v1/project/call" : STANDARD_ROUTES.has(args.route);
    if (!allowed) fail("route_denied");
    const body = await readJson(args.bodyFile, profile.mode === "installed" ? INSTALLED_BYTES : STANDARD_BYTES);
    await discover();
    return call(args.route, body);
  }
  if (profile.mode !== "standard") fail("service_mode_mismatch");
  if (args.command === "prepare") {
    const body = await readJson(args.bodyFile, STANDARD_BYTES);
    if (!exactKeys(body, ["recall", "consumerId", "purpose"]) || !object(body.recall) ||
        !text(body.consumerId) || !text(body.purpose)) fail("invalid_prepare_request");
    const owned = await exclusiveFile(path.resolve(args.useFile), "use_file_exists");
    let saved = false;
    let prepared = false;
    try {
      await discover();
      prepared = true;
      const data = await call("/v1/use/prepare", body);
      if (typeof data.use?.credential === "string") secrets.add(data.use.credential);
      if (!object(data.pack) || !object(data.use) || data.use.consumerId !== body.consumerId ||
          data.use.purpose !== body.purpose) fail("invalid_service_response");
      const value = ticket({
        schemaVersion: 1, baseUrl: profile.baseUrl, namespace: profile.expectedNamespace,
        credential: data.use.credential, consumerId: data.use.consumerId, purpose: data.use.purpose,
        expiresAt: data.use.expiresAt, packHash: data.use.packHash,
      }, profile);
      await saveReservation(owned, value);
      saved = true;
      return data;
    } catch (error) {
      if (prepared && error instanceof ClientError) error.details.recovery = {
        command: "manual_reconciliation", automaticRetry: false,
      };
      throw error;
    } finally { await closeOwned(owned, !saved, true); }
  }
  if (args.command === "status") {
    const value = await readTicket(args.useFile, profile);
    secrets.add(value.credential);
    await discover();
    return call("/v1/use/status", useArguments(value));
  }
  const file = path.resolve(args.useFile);
  let lock;
  let attempted = false;
  try {
    lock = await exclusiveFile(`${file}.lock`, "use_file_locked");
    const value = await readTicket(file, profile);
    secrets.add(value.credential);
    if (value.dispatchAttempted) fail("dispatch_already_attempted", { recovery: STATUS_RECOVERY });
    if (Date.parse(value.expiresAt) <= Date.now()) fail("use_credential_expired", { recovery: STATUS_RECOVERY });
    await discover();
    await markDispatchAttempted(file, value);
    attempted = true;
    return await call("/v1/use/dispatch", useArguments(value));
  } catch (error) {
    if (error instanceof ClientError && (attempted || error.code === "use_file_locked"))
      error.details.recovery = STATUS_RECOVERY;
    throw error;
  } finally { if (lock) await closeOwned(lock, true); }
}

/** No I/O occurs on import. Callers may supply writers for embedding or testing. */
export async function main(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? (value => process.stdout.write(value));
  const stderr = options.stderr ?? (value => process.stderr.write(value));
  const env = options.env ?? process.env;
  const secrets = new Set();
  try {
    if (Number(process.versions.node.split(".")[0]) < 22) fail("unsupported_node_version");
    const args = parseArguments(argv);
    const profile = await readProfile(args.config);
    const token = env[profile.tokenEnv];
    if (typeof token !== "string" || !TOKEN.test(token)) fail("invalid_identity_credential");
    secrets.add(token);
    const result = await run(args, profile, token, secrets, options.fetch ?? globalThis.fetch);
    stdout(`${JSON.stringify(redact(result, secrets))}\n`);
    return 0;
  } catch (error) {
    const result = error instanceof ClientError ? { code: error.code, ...error.details } : { code: "client_error" };
    stderr(`${JSON.stringify(redact(result, secrets))}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  process.exitCode = await main();
