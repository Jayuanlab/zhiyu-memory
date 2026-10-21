import {
  MemoryError,
  PROTOCOL,
  type AppendCommand,
  type Namespace,
  type Query,
  type RecordRef,
  type VersionRef,
} from "./contracts";
export function fail(code: string, status = 400): never {
  throw new MemoryError(code, status, code);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_request");
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    fail("invalid_request");
}
export function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("invalid_request");
  return value;
}
export function namespace(value: unknown): Namespace {
  const v = object(value);
  keys(v, ["tenantId", "projectId"]);
  return { tenantId: text(v.tenantId, 200), projectId: text(v.projectId, 200) };
}
export function date(value: unknown): string {
  const s = text(value, 64),
    m =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
        s,
      );
  if (!m) fail("invalid_request");
  const y = Number(m[1]),
    mo = Number(m[2]),
    d = Number(m[3]),
    days = [
      31,
      y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > days[mo - 1] ||
    Number(m[4]) > 23 ||
    Number(m[5]) > 59 ||
    Number(m[6]) > 59 ||
    (m[7] !== "Z" &&
      (Number(m[7].slice(1, 3)) > 23 || Number(m[7].slice(4)) > 59)) ||
    !Number.isFinite(Date.parse(s))
  )
    fail("invalid_request");
  return new Date(s).toISOString();
}
export function parseCommand(value: unknown): AppendCommand {
  const v = object(value);
  keys(v, ["protocolVersion", "kind", "commandId", "payload"]);
  if (v.protocolVersion !== PROTOCOL) fail("unsupported_version", 422);
  if (v.kind !== "observation.append") fail("unsupported_capability", 422);
  const p = object(v.payload);
  keys(p, ["source", "observedAt", "content", "extensions"]);
  const s = object(p.source);
  keys(s, ["sourceId", "externalId", "version"]);
  const source = {
    sourceId: text(s.sourceId, 200),
    externalId: text(s.externalId, 2048),
    ...(s.version === undefined ? {} : { version: text(s.version, 200) }),
  };
  const content = text(p.content, 262144);
  if (Buffer.byteLength(content, "utf8") > 262144) fail("budget_exceeded", 413);
  const extensions = p.extensions === undefined ? {} : object(p.extensions);
  let encoded: string;
  try {
    encoded = JSON.stringify(extensions);
  } catch {
    fail("invalid_request");
  }
  if (Buffer.byteLength(encoded, "utf8") > 16384) fail("budget_exceeded", 413);
  // Reject non-JSON values, cycles and lossy serialization before computing identity.
  function check(v: unknown): void {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (Array.isArray(v)) {
      v.forEach(check);
      return;
    }
    if (
      v &&
      typeof v === "object" &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      Object.values(v).forEach(check);
      return;
    }
    fail("invalid_request");
  }
  check(extensions);
  return {
    protocolVersion: PROTOCOL,
    kind: "observation.append",
    commandId: text(v.commandId, 200).trim(),
    payload: {
      source,
      observedAt: date(p.observedAt),
      content,
      extensions: JSON.parse(encoded),
    },
  };
}
function ref(value: unknown): RecordRef {
  const v = object(value);
  keys(v, ["tenantId", "projectId", "kind", "id"]);
  if (v.kind !== "observation") fail("unsupported_capability", 422);
  return {
    ...namespace({ tenantId: v.tenantId, projectId: v.projectId }),
    kind: "observation",
    id: text(v.id, 200),
  };
}
export function parseQuery(value: unknown): Query {
  const v = object(value);
  if (v.purpose === "receipt") {
    keys(v, ["purpose", "commandId"]);
    return { purpose: "receipt", commandId: text(v.commandId, 200).trim() };
  }
  if (v.purpose !== "current" && v.purpose !== "evidence")
    fail("unsupported_capability", 422);
  keys(
    v,
    v.purpose === "current" ? ["purpose", "ref"] : ["purpose", "ref", "range"],
  );
  if (v.purpose === "current") return { purpose: "current", ref: ref(v.ref) };
  const fixed = object(v.ref);
  keys(fixed, ["record", "scheme", "value"]);
  const r = object(v.range);
  keys(r, ["start", "end", "unit"]);
  if (
    r.unit !== "unicode_code_points" ||
    !Number.isSafeInteger(r.start) ||
    !Number.isSafeInteger(r.end) ||
    (r.start as number) < 0 ||
    (r.end as number) < (r.start as number) ||
    (r.end as number) - (r.start as number) > 8192
  )
    fail("invalid_request");
  return {
    purpose: "evidence",
    ref: {
      record: ref(fixed.record),
      scheme: text(fixed.scheme, 100),
      value: text(fixed.value, 300),
    } as VersionRef,
    range: {
      start: r.start as number,
      end: r.end as number,
      unit: "unicode_code_points",
    },
  };
}
