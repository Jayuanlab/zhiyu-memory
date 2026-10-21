import { createHash, randomUUID } from "node:crypto";
import {
  PROTOCOL,
  type Namespace,
  type Observation,
  type VersionRef,
  type AppendResult,
  type Meta,
  type ReadResult,
} from "./contracts";
import type {
  Identity,
  ObservationFormat,
  ObservationStore,
  SourceDescriptor,
} from "./ports";
import { fail, namespace, parseCommand, parseQuery, text } from "./validation";
import { createSourceRegistry } from "./sources";
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
    .join(",")}}`;
}
export const digest = (v: unknown) =>
  createHash("sha256").update(stableJson(v)).digest("hex");
export const defaultFormat: ObservationFormat = {
  commandHash: digest,
  version: (r) => ({
    record: { ...r.namespace, kind: "observation", id: r.id },
    scheme: "gobsrv1",
    value: digest([
      "gobsrv1",
      r.namespace,
      r.id,
      r.source,
      r.observedAt,
      r.content,
      r.provenance,
      r.extensions,
    ]),
  }),
};
export type Installation = {
  store: ObservationStore;
  sources: readonly SourceDescriptor[];
  format?: ObservationFormat;
  now?: () => Date;
  newId?: () => string;
};
const same = (a: Namespace, b: Namespace) =>
  a.tenantId === b.tenantId && a.projectId === b.projectId;
/** Host-only construction; the returned client cannot select its principal or namespace. */
export function bindClient(config: Installation, identity: Identity) {
  const fixed = structuredClone({
    ...identity,
    namespace: namespace(identity.namespace),
    principalId: text(identity.principalId, 200),
  });
  Object.freeze(fixed.namespace);
  Object.freeze(fixed);
  const sources = createSourceRegistry(config.sources);
  const format = config.format ?? defaultFormat,
    now = config.now ?? (() => new Date()),
    id = config.newId ?? randomUUID;
  const meta = (detail: string): Meta => ({
    traceId: fixed.traceId,
    protocolVersion: PROTOCOL,
    implementationVersion: "memory-g1.v1",
    provider: config.store.provider,
    detail,
    warnings: [],
  });
  function assertRecord(r: Observation) {
    if (!same(r.namespace, fixed.namespace)) fail("namespace_mismatch", 403);
    if (!sources.has(r.source.sourceId)) fail("source_unregistered", 403);
  }
  return {
    capabilities() {
      return {
        protocolVersion: PROTOCOL,
        implementationVersion: "memory-g1.v1",
        schemaVersion: "memory-observations.g1",
        level: "R",
        namespace: structuredClone(fixed.namespace),
        namespaceIsolation: "adapter_enforced",
        commands: ["observation.append"],
        reads: ["current", "evidence", "receipt"],
      sources: sources.list().map(({ validateExtensions, ...s }) => s),
        limits: {
          contentBytes: 262144,
          extensionsBytes: 16384,
          evidenceCodePoints: 8192,
        },
        history: "immutable_observations",
        atomicReadReceipt: true,
        consumerCoverage: [],
        policyVersion: null,
        meta: meta("record_only_no_recall_or_dispatch"),
      };
    },
    async execute(value: unknown): Promise<AppendResult> {
      const command = parseCommand(value),
        descriptor = sources.get(command.payload.source.sourceId);
      if (!descriptor) fail("source_unregistered", 403);
      if (descriptor.validateExtensions)
        descriptor.validateExtensions(command.payload.extensions ?? {});
      else if (Object.keys(command.payload.extensions ?? {}).length)
        fail("unsupported_extension", 422);
      const requestHash = format.commandHash(command);
      return config.store.transaction(async (tx) => {
        await tx.authorize(fixed, "append");
        await tx.lockCommand(fixed, command.commandId);
        const previous = await tx.command(fixed, command.commandId);
        if (previous) {
          if (previous.requestHash !== requestHash)
            fail("idempotency_conflict", 409);
          const r = await tx.observation(
            fixed.namespace,
            previous.receipt.ref.record.id,
          );
          if (!r) fail("receipt_source_unavailable", 409);
          assertRecord(r);
          if (
            stableJson(format.version(r)) !== stableJson(previous.receipt.ref)
          )
            fail("receipt_source_unavailable", 409);
          return {
            status: "committed",
            replayed: true,
            observation: r,
            ref: previous.receipt.ref,
            receipt: previous.receipt,
            meta: meta("observation_replay"),
          };
        }
        const r = await tx.append(fixed, {
          namespace: structuredClone(fixed.namespace),
          id: id(),
          source: command.payload.source,
          observedAt: command.payload.observedAt,
          ingestedAt: now().toISOString(),
          content: command.payload.content,
          contentHash: digest(command.payload.content),
          provenance: {
            kind: descriptor.kind,
            trustLevel: descriptor.trustLevel,
          },
          extensions: command.payload.extensions ?? {},
        });
        assertRecord(r);
        const ref = format.version(r),
          receipt = await tx.saveCommand(fixed, {
            requestHash,
            receipt: {
              id: id(),
              commandId: command.commandId,
              ref,
              createdAt: now().toISOString(),
            },
          });
        return {
          status: "committed",
          replayed: false,
          observation: r,
          ref,
          receipt,
          meta: meta("observation_append"),
        };
      });
    },
    async read(value: unknown): Promise<ReadResult> {
      const q = parseQuery(value);
      const target =
        q.purpose === "receipt"
          ? undefined
          : q.purpose === "current"
            ? q.ref
            : q.ref.record;
      if (target && !same(target, fixed.namespace))
        fail("namespace_mismatch", 403);
      return config.store.transaction(async (tx) => {
        await tx.authorize(fixed, q.purpose === "receipt" ? "receipt" : "read");
        if (q.purpose === "receipt") {
          const saved = await tx.command(fixed, q.commandId);
          return saved
            ? {
                status: "committed",
                receipt: saved.receipt,
                meta: meta("command_receipt"),
              }
            : {
                status: "not_found",
                code: "command_not_found",
                meta: meta("command_receipt"),
              };
        }
        const r = await tx.observation(fixed.namespace, target!.id);
        if (!r)
          return {
            status: "not_found",
            code: "observation_not_found",
            meta: meta("exact_observation_read"),
          };
        assertRecord(r);
        const ref = format.version(r);
        if (q.purpose === "evidence" && stableJson(q.ref) !== stableJson(ref))
          return {
            status: "unavailable",
            code: "version_mismatch",
            meta: meta("exact_observation_read"),
          };
        const chars = Array.from(r.content),
          requested =
            q.purpose === "evidence"
              ? q.range
              : {
                  start: 0,
                  end: chars.length,
                  unit: "unicode_code_points" as const,
                };
        if (requested.start > chars.length) fail("invalid_request");
        const actualRange = {
            ...requested,
            end: Math.min(requested.end, chars.length),
          },
          receipt = await tx.saveRead(fixed, {
            id: id(),
            purpose: q.purpose,
            ref,
            actualRange,
            totalLength: chars.length,
            createdAt: now().toISOString(),
          });
        return {
          status: "ok",
          content: chars.slice(actualRange.start, actualRange.end).join(""),
          ref,
          receipt,
          meta: meta("exact_observation_read"),
        };
      });
    },
  };
}
