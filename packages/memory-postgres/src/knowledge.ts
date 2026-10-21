import type { Sql, TransactionSql } from "postgres";
import type { Identity } from "../../memory/src/ports";
import type {
	KnowledgeStore,
	KnowledgeOperation,
	KnowledgeSourceRef,
	KnowledgeSource,
	KnowledgeRecord,
	KnowledgeReceipt,
	KnowledgeAudit,
	RemoteUseTicket,
} from "../../memory/src/knowledge-contracts";
/** Independent K/U storage; no migration or access to any legacy project table. */
export async function initializeKnowledgeSchema(sql: Sql) {
	await sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtextextended('general-memory.g4.schema',0))`;
		await tx`CREATE TABLE IF NOT EXISTS general_memory_remote_use_g5 (
      tenant_id text NOT NULL,project_id text NOT NULL,principal_id text NOT NULL,token_hash text NOT NULL,ticket jsonb NOT NULL,
      PRIMARY KEY(tenant_id,project_id,principal_id,token_hash))`;
		await tx`CREATE TABLE IF NOT EXISTS general_memory_knowledge_g4 (
      tenant_id text NOT NULL,project_id text NOT NULL,id text NOT NULL,scope text NOT NULL,fingerprint text NOT NULL,record jsonb NOT NULL,
      PRIMARY KEY(tenant_id,project_id,id))`;
		await tx`CREATE TABLE IF NOT EXISTS general_memory_knowledge_history_g4 (
      tenant_id text NOT NULL,project_id text NOT NULL,id text NOT NULL,version text NOT NULL,record jsonb NOT NULL,
      PRIMARY KEY(tenant_id,project_id,id,version))`;
		await tx`CREATE TABLE IF NOT EXISTS general_memory_knowledge_commands_g4 (
      tenant_id text NOT NULL,project_id text NOT NULL,principal_id text NOT NULL,command_id text NOT NULL,request_hash text NOT NULL,receipt jsonb NOT NULL,
      PRIMARY KEY(tenant_id,project_id,principal_id,command_id))`;
		await tx`CREATE TABLE IF NOT EXISTS general_memory_knowledge_audits_g4 (
      tenant_id text NOT NULL,project_id text NOT NULL,principal_id text NOT NULL,id text NOT NULL,kind text NOT NULL,record jsonb NOT NULL,
      PRIMARY KEY(tenant_id,project_id,id))`;
		await tx`CREATE INDEX IF NOT EXISTS general_memory_knowledge_scope_g4 ON general_memory_knowledge_g4(tenant_id,project_id,scope,id)`;
		await tx`CREATE INDEX IF NOT EXISTS general_memory_knowledge_fingerprint_g4 ON general_memory_knowledge_g4(tenant_id,project_id,fingerprint)`;
		await tx.unsafe(
			"CREATE OR REPLACE FUNCTION general_memory_g4_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable knowledge audit'; END $$",
		);
		for (const table of [
			"general_memory_knowledge_history_g4",
			"general_memory_knowledge_commands_g4",
			"general_memory_knowledge_audits_g4",
		]) {
			await tx.unsafe(
				`DROP TRIGGER IF EXISTS general_memory_g4_immutable ON ${table}`,
			);
			await tx.unsafe(
				`CREATE TRIGGER general_memory_g4_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION general_memory_g4_append_only()`,
			);
		}
	});
}
export function createPostgresKnowledgeStore(
	sql: Sql,
	ports: {
		authorize(
			tx: TransactionSql,
			identity: Identity,
			operation: KnowledgeOperation,
		): Promise<void>;
		source(
			tx: TransactionSql,
			identity: Identity,
			ref: KnowledgeSourceRef,
		): Promise<KnowledgeSource>;
	},
): KnowledgeStore {
	if (
		typeof ports.authorize !== "function" ||
		typeof ports.source !== "function"
	)
		throw Error("trusted_knowledge_adapters_required");
	return {
		provider: "postgres",
		async transaction<T>(
			work: Parameters<KnowledgeStore["transaction"]>[0],
		): Promise<T> {
			return (await sql.begin(async (tx) =>
				work({
					remoteUse: {
						insert: async (i, ticket) => {
							const n = i.namespace;
							await tx`INSERT INTO general_memory_remote_use_g5 VALUES(${n.tenantId},${n.projectId},${i.principalId},${ticket.tokenHash},${tx.json(ticket as any)})`;
						},
						get: async (i, hash) => {
							const n = i.namespace;
							const [r] =
								await tx`SELECT ticket FROM general_memory_remote_use_g5 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND principal_id=${i.principalId} AND token_hash=${hash} FOR UPDATE`;
							return r ? (r.ticket as RemoteUseTicket) : null;
						},
						consume: async (i, hash, admissionId) => {
							const n = i.namespace;
							const rows =
								await tx`UPDATE general_memory_remote_use_g5 SET ticket=jsonb_set(ticket,'{admissionId}',to_jsonb(${admissionId}::text)) WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND principal_id=${i.principalId} AND token_hash=${hash} AND NOT(ticket ? 'admissionId') RETURNING token_hash`;
							if (rows.length !== 1) throw Error("remote_use_already_consumed");
						},
					},
					authorize: (i, op) => ports.authorize(tx, i, op),
					lock: async (i, key) => {
						await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([i.namespace, key])},0))`;
					},
					command: async (i, id) => {
						const n = i.namespace,
							[r] =
								await tx`SELECT request_hash,receipt FROM general_memory_knowledge_commands_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND principal_id=${i.principalId} AND command_id=${id}`;
						return r
							? {
									requestHash: r.request_hash as string,
									receipt: r.receipt as KnowledgeReceipt,
								}
							: null;
					},
					saveCommand: async (i, hash, r) => {
						const n = i.namespace;
						await tx`INSERT INTO general_memory_knowledge_commands_g4 VALUES(${n.tenantId},${n.projectId},${i.principalId},${r.commandId},${hash},${tx.json(r as any)})`;
					},
					record: async (i, id, lock) => {
						const n = i.namespace;
						const rows =
							lock === "update"
								? await tx`SELECT record FROM general_memory_knowledge_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND id=${id} FOR UPDATE`
								: await tx`SELECT record FROM general_memory_knowledge_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND id=${id} FOR SHARE`;
						return (rows[0]?.record as KnowledgeRecord) ?? null;
					},
					byFingerprint: async (i, fingerprint) => {
						const n = i.namespace,
							[r] =
								await tx`SELECT record FROM general_memory_knowledge_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND fingerprint=${fingerprint} ORDER BY id LIMIT 1 FOR SHARE`;
						return (r?.record as KnowledgeRecord) ?? null;
					},
					list: async (i, scope, limit) => {
						const n = i.namespace;
						return (
							await tx`SELECT record FROM general_memory_knowledge_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND scope=${scope} ORDER BY id LIMIT ${limit} FOR SHARE`
						).map((r) => r.record as KnowledgeRecord);
					},
					saveRecord: async (i, r) => {
						const n = i.namespace;
						if (
							r.namespace.tenantId !== n.tenantId ||
							r.namespace.projectId !== n.projectId
						)
							throw Error("knowledge_namespace_mismatch");
						await tx`INSERT INTO general_memory_knowledge_g4 VALUES(${n.tenantId},${n.projectId},${r.id},${r.scope},${r.fingerprint},${tx.json(r as any)}) ON CONFLICT(tenant_id,project_id,id) DO UPDATE SET record=EXCLUDED.record`;
						await tx`INSERT INTO general_memory_knowledge_history_g4 VALUES(${n.tenantId},${n.projectId},${r.id},${r.version},${tx.json(r as any)}) ON CONFLICT DO NOTHING`;
					},
					source: (i, ref) => ports.source(tx, i, ref),
					useReceipts: async (i, id) => {
						const n = i.namespace;
						return (
							await tx`SELECT record FROM general_memory_knowledge_audits_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND principal_id=${i.principalId} AND kind IN ('use_admitted','use_dispatched','use_outcome_unknown') AND (id=${id} OR record->'data'->>'admissionId'=${id}) ORDER BY id LIMIT 20`
						).map((r) => r.record as KnowledgeAudit);
					},
					audit: async (i, r) => {
						const n = i.namespace;
						await tx`INSERT INTO general_memory_knowledge_audits_g4 VALUES(${n.tenantId},${n.projectId},${i.principalId},${r.id},${r.kind},${tx.json(r as any)})`;
					},
				}),
			)) as T;
		},
	};
}
