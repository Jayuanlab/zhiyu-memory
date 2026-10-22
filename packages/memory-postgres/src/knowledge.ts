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
		await tx`CREATE TABLE IF NOT EXISTS general_memory_embeddings_g6 (
      tenant_id text NOT NULL,project_id text NOT NULL,record_id text NOT NULL,space_id text NOT NULL,input_hash text NOT NULL,vector double precision[] NOT NULL,
      PRIMARY KEY(tenant_id,project_id,record_id,space_id),
      CHECK(array_ndims(vector)=1 AND cardinality(vector)>0))`;
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
					embeddings: {
						get: async (i, recordId, spaceId, inputHash) => {
							const n = i.namespace,
								[r] =
									await tx`SELECT vector FROM general_memory_embeddings_g6 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND record_id=${recordId} AND space_id=${spaceId} AND input_hash=${inputHash}`;
							return r ? (r.vector as number[]) : null;
						},
						put: async (i, recordId, spaceId, inputHash, vector) => {
							if (!vector.length || vector.some((value) => !Number.isFinite(value)))
								throw Error("invalid_embedding_vector");
							const n = i.namespace;
							await tx`INSERT INTO general_memory_embeddings_g6(tenant_id,project_id,record_id,space_id,input_hash,vector) VALUES(${n.tenantId},${n.projectId},${recordId},${spaceId},${inputHash},${tx.array(Array.from(vector), 701)}::double precision[]) ON CONFLICT(tenant_id,project_id,record_id,space_id) DO UPDATE SET input_hash=EXCLUDED.input_hash,vector=EXCLUDED.vector`;
						},
					},
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
					scan: async (i, scope, afterId, limit) => {
						if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
							throw Error("invalid_knowledge_scan_limit");
						const n = i.namespace;
						const rows = afterId === undefined
							? await tx`SELECT record FROM general_memory_knowledge_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND scope=${scope} ORDER BY id LIMIT ${limit} FOR SHARE`
							: await tx`SELECT record FROM general_memory_knowledge_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND scope=${scope} AND id>${afterId} ORDER BY id LIMIT ${limit} FOR SHARE`;
						return rows.map((r) => r.record as KnowledgeRecord);
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
