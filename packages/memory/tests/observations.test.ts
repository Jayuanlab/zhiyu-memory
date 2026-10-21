import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryHost } from "../src/host";
import {
  PROTOCOL,
  MemoryError,
  type Observation,
  type CommandReceipt,
  type ReadReceipt,
} from "../src/index";
import type { ObservationStore, StoredCommand, Identity } from "../src/ports";
import { stableJson } from "../src/core";
function fixture() {
  let state = {
    observations: [] as Observation[],
    commands: [] as Array<{ identity: Identity; stored: StoredCommand }>,
    reads: [] as ReadReceipt[],
  };
  let tail = Promise.resolve();
  let failAudit = false,
    allowed = true;
  const key = (i: Identity) => stableJson([i.namespace, i.principalId]);
  const store: ObservationStore = {
    provider: "test-memory-only",
    transaction<T>(work: (tx: any) => Promise<T>) {
      const result = tail.then(async () => {
        const next = structuredClone(state);
        const value = await work({
          authorize: async () => {
            if (!allowed)
              throw new MemoryError("access_denied", 403, "Revoked");
          },
          lockCommand: async () => {},
          command: async (i: Identity, c: string) =>
            next.commands.find(
              (x) =>
                key(x.identity) === key(i) && x.stored.receipt.commandId === c,
            )?.stored ?? null,
          observation: async (n: unknown, id: string) =>
            next.observations.find(
              (r) => stableJson(r.namespace) === stableJson(n) && r.id === id,
            ) ?? null,
          append: async (_i: Identity, r: Observation) => {
            const prior = next.observations.find(
              (x) =>
                stableJson([x.namespace, x.source]) ===
                stableJson([r.namespace, r.source]),
            );
            if (prior) {
              if (
                stableJson([
                  prior.content,
                  prior.observedAt,
                  prior.extensions,
                ]) !== stableJson([r.content, r.observedAt, r.extensions])
              )
                throw new MemoryError("source_conflict", 409, "Conflict");
              return prior;
            }
            next.observations.push(r);
            return r;
          },
          saveCommand: async (i: Identity, s: StoredCommand) => {
            if (failAudit) throw Error("audit_failed");
            next.commands.push({ identity: i, stored: s });
            return s.receipt;
          },
          saveRead: async (_i: Identity, r: ReadReceipt) => {
            if (failAudit) throw Error("audit_failed");
            next.reads.push(r);
            return r;
          },
        });
        state = structuredClone(next);
        return structuredClone(value);
      });
      tail = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
  const host = createMemoryHost(
    {
      store,
      sources: [
        {
          id: "build",
          adapterVersion: "fixture.v1",
          kind: "build_report",
          trustLevel: "raw",
        },
      ],
    },
    async (session: string) => {
      if (!session) throw new MemoryError("access_denied", 403, "No session");
      return {
        namespace: { tenantId: "tenant", projectId: session },
        principalId: "reader",
      };
    },
  );
  return {
    host,
    get state() {
      return state;
    },
    set failAudit(v: boolean) {
      failAudit = v;
    },
    set allowed(v: boolean) {
      allowed = v;
    },
  };
}
const command = {
  protocolVersion: PROTOCOL,
  kind: "observation.append",
  commandId: "retry-one",
  payload: {
    source: { sourceId: "build", externalId: "ci-7", version: "1" },
    observedAt: "2026-10-21T01:00:00Z",
    content: "原始🧭\r\n报告",
  },
};
test("portable observation save / exact Unicode read / concurrent replay / receipt recovery", async () => {
  const f = fixture(),
    c = await f.host.forSession("dev"),
    [a, b] = await Promise.all([c.execute(command), c.execute(command)]);
  assert.equal(a.receipt.id, b.receipt.id);
  assert.equal(b.replayed, true);
  assert.equal(f.state.observations.length, 1);
  assert.equal(f.state.commands.length, 1);
  const read = await c.read({
    purpose: "evidence",
    ref: a.ref,
    range: { start: 2, end: 5, unit: "unicode_code_points" },
  });
  assert.equal(read.status, "ok");
  if (read.status === "ok") {
    assert.equal(read.content, "🧭\r\n");
    assert.equal(read.receipt.totalLength, 7);
  }
  const fresh = await f.host.forSession("dev");
  assert.deepEqual(
    (await fresh.read({ purpose: "receipt", commandId: command.commandId }))
      .status,
    "committed",
  );
  assert.equal((await fresh.execute(command)).receipt.id, a.receipt.id);
});
test("same ID different content and same source different content cannot overwrite", async () => {
  const f = fixture(),
    c = await f.host.forSession("dev");
  await c.execute(command);
  await assert.rejects(
    c.execute({
      ...command,
      payload: { ...command.payload, content: "changed" },
    }),
    { code: "idempotency_conflict" },
  );
  await assert.rejects(
    c.execute({
      ...command,
      commandId: "other",
      payload: { ...command.payload, content: "changed" },
    }),
    { code: "source_conflict" },
  );
  assert.equal(f.state.commands.length, 1);
});
test("same source / new command deduplicates original without renewing its observation", async () => {
  const f = fixture(),
    c = await f.host.forSession("dev"),
    a = await c.execute(command),
    b = await c.execute({ ...command, commandId: "other" });
  assert.deepEqual(a.observation, b.observation);
  assert.equal(f.state.observations.length, 1);
  assert.equal(f.state.commands.length, 2);
});
test("projects cannot read each other, even under the same principal and tenant", async () => {
  const f = fixture(),
    a = await f.host.forSession("A"),
    b = await f.host.forSession("B"),
    saved = await a.execute(command);
  await assert.rejects(b.read({ purpose: "current", ref: saved.ref.record }), {
    code: "namespace_mismatch",
  });
  assert.equal(
    (
      await b.read({
        purpose: "current",
        ref: { ...saved.ref.record, projectId: "B" },
      })
    ).status,
    "not_found",
  );
  assert.equal(
    (await b.read({ purpose: "receipt", commandId: command.commandId })).status,
    "not_found",
  );
  const other = await b.execute(command);
  assert.notEqual(other.ref.record.id, saved.ref.record.id);
});
test("namespace returned in a record cannot mutate a client's authority", async () => {
  const f = fixture(),
    c = await f.host.forSession("A"),
    saved = await c.execute(command);
  saved.observation.namespace.projectId = "B";
  assert.equal((await c.execute(command)).ref.record.projectId, "A");
});
test("revocation is checked for append retries, reads and receipt recovery", async () => {
  const f = fixture(),
    c = await f.host.forSession("A"),
    saved = await c.execute(command);
  f.allowed = false;
  for (const op of [
    () => c.execute(command),
    () => c.read({ purpose: "current", ref: saved.ref.record }),
    () => c.read({ purpose: "receipt", commandId: command.commandId }),
  ])
    await assert.rejects(op(), { code: "access_denied" });
});
test("audit failure rolls back append and never returns an unaudited read", async () => {
  const f = fixture(),
    c = await f.host.forSession("A");
  f.failAudit = true;
  await assert.rejects(c.execute(command), /audit_failed/);
  assert.equal(f.state.observations.length, 0);
  f.failAudit = false;
  const r = await c.execute(command);
  f.failAudit = true;
  await assert.rejects(
    c.read({ purpose: "current", ref: r.ref.record }),
    /audit_failed/,
  );
  assert.equal(f.state.reads.length, 0);
});
test("strict fields, registered sources, versions, dates, range units and JSON limits", async () => {
  const f = fixture(),
    c = await f.host.forSession("A");
  for (const value of [
    { ...command, userId: "owner" },
    { ...command, protocolVersion: "v900" },
    { ...command, kind: "interpretation.review" },
    {
      ...command,
      payload: {
        ...command.payload,
        source: { ...command.payload.source, sourceId: "unknown" },
      },
    },
    {
      ...command,
      payload: { ...command.payload, observedAt: "2026-02-30T01:00:00Z" },
    },
    {
      ...command,
      payload: { ...command.payload, extensions: { verified: true } },
    },
    {
      ...command,
      payload: { ...command.payload, content: "🧭".repeat(70000) },
    },
  ])
    await assert.rejects(c.execute(value));
  const saved = await c.execute(command);
  assert.equal(
    (
      await c.read({
        purpose: "evidence",
        ref: { ...saved.ref, value: "wrong" },
        range: { start: 0, end: 1, unit: "unicode_code_points" },
      })
    ).status,
    "unavailable",
  );
  await assert.rejects(
    c.read({
      purpose: "evidence",
      ref: saved.ref,
      range: { start: 0, end: 1, unit: "utf16" },
    }),
  );
  assert.equal(f.state.reads.length, 0);
  assert.equal(c.capabilities().level, "R");
  assert.deepEqual(c.capabilities().consumerCoverage, []);
});
