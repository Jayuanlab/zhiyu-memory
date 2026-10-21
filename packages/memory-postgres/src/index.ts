import type { Sql, TransactionSql } from "postgres";
import type { Identity, ObservationStore } from "../../memory/src/ports";
import type {
  Observation,
  Namespace,
  CommandReceipt,
} from "../../memory/src/contracts";
import { MemoryError } from "../../memory/src/contracts";
import { stableJson } from "../../memory/src/core";
/** Explicit bootstrap for an independent deployment. Never invoked by the Zhiyu legacy Adapter. */
export async function initializeObservationSchema(sql: Sql) {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('general-memory.g1.schema',0))`;
    await tx`CREATE TABLE IF NOT EXISTS general_memory_observations_g1 (
      tenant_id text NOT NULL, project_id text NOT NULL, id text NOT NULL,
      source_id text NOT NULL, external_id text NOT NULL, source_version text NOT NULL,
      record jsonb NOT NULL, PRIMARY KEY(tenant_id,project_id,id),
      UNIQUE(tenant_id,project_id,source_id,external_id,source_version))`;
    await tx`CREATE TABLE IF NOT EXISTS general_memory_commands_g1 (
      tenant_id text NOT NULL, project_id text NOT NULL, principal_id text NOT NULL,
      command_id text NOT NULL, request_hash text NOT NULL, receipt jsonb NOT NULL,
      PRIMARY KEY(tenant_id,project_id,principal_id,command_id))`;
    await tx`CREATE TABLE IF NOT EXISTS general_memory_reads_g1 (
      tenant_id text NOT NULL, project_id text NOT NULL, principal_id text NOT NULL,
      id text NOT NULL, receipt jsonb NOT NULL, PRIMARY KEY(tenant_id,project_id,id))`;
    await tx`CREATE TABLE IF NOT EXISTS general_memory_schema_g1 (version integer PRIMARY KEY CHECK(version=1))`;
    await tx`INSERT INTO general_memory_schema_g1(version) VALUES(1) ON CONFLICT DO NOTHING`;
    await tx.unsafe(
      "CREATE OR REPLACE FUNCTION general_memory_observation_immutable_g1() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable observation'; END $$",
    );
    await tx.unsafe(
      "DROP TRIGGER IF EXISTS general_memory_observation_immutable_g1 ON general_memory_observations_g1",
    );
    await tx.unsafe(
      "CREATE TRIGGER general_memory_observation_immutable_g1 BEFORE UPDATE OR DELETE ON general_memory_observations_g1 FOR EACH ROW EXECUTE FUNCTION general_memory_observation_immutable_g1()",
    );
  });
}
type Authority = (
  tx: TransactionSql,
  identity: Identity,
  operation: "append" | "read" | "receipt",
) => Promise<void>;
export function createPostgresObservationStore(
  sql: Sql,
  authorize: Authority,
): ObservationStore {
  if (typeof authorize !== "function")
    throw new MemoryError(
      "access_denied",
      403,
      "A trusted transactional authority is required",
    );
  return {
    provider: "postgres",
    async transaction<T>(
      work: Parameters<ObservationStore["transaction"]>[0],
    ): Promise<T> {
      return (await sql.begin(async (tx) =>
        work({
          authorize: (identity, operation) =>
            authorize(tx, identity, operation),
          async lockCommand(i, c) {
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${stableJson(["g1.command", i.namespace, i.principalId, c])},0))`;
          },
          async command(i, c) {
            const [r] =
              await tx`SELECT request_hash,receipt FROM general_memory_commands_g1 WHERE tenant_id=${i.namespace.tenantId} AND project_id=${i.namespace.projectId} AND principal_id=${i.principalId} AND command_id=${c}`;
            return r
              ? {
                  requestHash: r.request_hash as string,
                  receipt: r.receipt as CommandReceipt,
                }
              : null;
          },
          async observation(n: Namespace, id: string) {
            const [r] =
              await tx`SELECT record FROM general_memory_observations_g1 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND id=${id} FOR SHARE`;
            return r ? (r.record as Observation) : null;
          },
          async append(i, r) {
            const n = i.namespace,
              s = r.source;
            await tx`SELECT pg_advisory_xact_lock(hashtextextended(${stableJson(["g1.source", n, s])},0))`;
            const [saved] =
              await tx`INSERT INTO general_memory_observations_g1(tenant_id,project_id,id,source_id,external_id,source_version,record)
          VALUES(${n.tenantId},${n.projectId},${r.id},${s.sourceId},${s.externalId},${s.version ?? ""},${tx.json(r as any)}) ON CONFLICT DO NOTHING RETURNING record`;
            if (saved) return saved.record as Observation;
            const [old] =
              await tx`SELECT record FROM general_memory_observations_g1 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND source_id=${s.sourceId} AND external_id=${s.externalId} AND source_version=${s.version ?? ""} FOR SHARE`;
            if (!old)
              throw new MemoryError(
                "source_conflict",
                409,
                "Observation identity conflict",
              );
            const original = old.record as Observation,
              semantics = (x: Observation) => [
                x.namespace,
                x.source,
                x.observedAt,
                x.content,
                x.provenance,
                x.extensions,
              ];
            if (stableJson(semantics(original)) !== stableJson(semantics(r)))
              throw new MemoryError(
                "source_conflict",
                409,
                "Immutable source identity already has different content",
              );
            return original;
          },
          async saveCommand(i, r) {
            await tx`INSERT INTO general_memory_commands_g1(tenant_id,project_id,principal_id,command_id,request_hash,receipt) VALUES(${i.namespace.tenantId},${i.namespace.projectId},${i.principalId},${r.receipt.commandId},${r.requestHash},${tx.json(r.receipt as any)})`;
            return r.receipt;
          },
          async saveRead(i, r) {
            await tx`INSERT INTO general_memory_reads_g1(tenant_id,project_id,principal_id,id,receipt) VALUES(${i.namespace.tenantId},${i.namespace.projectId},${i.principalId},${r.id},${tx.json(r as any)})`;
            return r;
          },
        }),
      )) as T;
    },
  };
}
