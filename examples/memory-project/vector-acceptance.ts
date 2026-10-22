import assert from "node:assert/strict";
import fs from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import postgres from "postgres";
import type { Identity } from "../../packages/memory/src/ports";
import type { KnowledgeRecord } from "../../packages/memory/src/knowledge-contracts";
import {
	createPostgresKnowledgeStore,
	initializeKnowledgeSchema,
} from "../../packages/memory-postgres/src/knowledge";
import { createRemoteMemoryClient } from "../../packages/memory/src/http";
import { evaluateBusinessPolicy } from "../../packages/memory/src/policy";
import {
	createServiceIdentityProvider,
	initializeServiceIdentitySchema,
} from "../../packages/memory-postgres/src/service-identity";
import { initializeDevelopmentProject, developmentDocumentVersion } from "./knowledge-project";
import { developmentMemoryPolicy } from "./policy";

async function remoteVectorAcceptance(sql: ReturnType<typeof postgres>, url: string, checks: string[]) {
	const children: ChildProcess[] = [],
		inputs: string[] = [],
		deliveries: unknown[] = [];
	let providerFails = false;
	const stub = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			response.setHeader("content-type", "application/json");
			if (request.url === "/model") {
				deliveries.push(body);
				response.end(JSON.stringify({ acknowledged: true }));
				return;
			}
			assert.equal(request.url, "/embeddings");
			assert.ok(Array.isArray(body.input));
			assert.ok(["synthetic-model-a", "synthetic-model-b"].includes(body.model));
			if (providerFails) {
				response.statusCode = 503;
				response.end(JSON.stringify({ error: "synthetic_outage" }));
				return;
			}
			inputs.push(...body.input);
			response.end(JSON.stringify({ data: body.input.map((text: string, index: number) => ({
				index,
				embedding: text === "reduce memory consumption" || text.includes("Use cache eviction")
					? [1, 0, 0]
					: text.startsWith("[") && text.includes("Unrelated distractor")
						? [0, 1, 0]
						: [0, 0, 1],
			})) }));
		} catch {
			response.statusCode = 500;
			response.end(JSON.stringify({ error: "synthetic_stub_failed" }));
		}
	});
	stub.listen(0, "127.0.0.1");
	await once(stub, "listening");
	const address = stub.address();
	assert.ok(address && typeof address !== "string");
	const port = address.port;
	async function start(model = "synthetic-model-a") {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			MEMORY_SERVICE_PROJECT_MODULE: "",
			MEMORY_SERVICE_DATABASE_URL: url,
			MEMORY_SERVICE_PORT: "0",
			MEMORY_SERVICE_CONSUMER_URL: `http://127.0.0.1:${port}/model`,
			MEMORY_EMBEDDING_URL: `http://127.0.0.1:${port}/embeddings`,
			MEMORY_EMBEDDING_MODEL: model,
			MEMORY_EMBEDDING_DIMENSIONS: "3",
		};
		delete env.MEMORY_EMBEDDING_API_KEY;
		const child = fork("apps/service/main.ts", [], {
			execArgv: ["--import", "tsx"], env,
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		children.push(child);
		let timer: NodeJS.Timeout | undefined;
		try {
			const ready = await Promise.race([
				once(child, "message"),
				once(child, "exit").then(() => { throw Error("vector_service_exited_before_ready"); }),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("vector_service_start_timeout")), 20000); }),
			]);
			assert.equal(ready[0].ready, true);
			return { child, origin: `http://127.0.0.1:${ready[0].port}/` };
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	async function stop(child: ChildProcess) {
		if (child.exitCode !== null) return;
		const done = once(child, "exit");
		child.send("stop");
		await done;
	}
	const corpusCalls = () => inputs.filter((text) => text.startsWith("[")).length;
	try {
		await initializeDevelopmentProject(sql);
		await initializeServiceIdentitySchema(sql);
		const n = { tenantId: "semantic-org", projectId: "semantic-project" },
			i: Identity = { namespace: n, principalId: "vector-reader", traceId: "trusted-seed" },
			all = ["read", "recall", "use", "receipt"],
			asOf = new Date().toISOString(),
			content = "Approved project guidance.";
		await sql`INSERT INTO demo_dev_members_g4 VALUES(${n.tenantId},${n.projectId},${i.principalId},${sql.json(all)},'[]'::jsonb)`;
		await sql`INSERT INTO demo_dev_source_grants_g4 VALUES(${n.tenantId},${n.projectId},${i.principalId},'semantic-guide',true,false)`;
		await sql`INSERT INTO demo_dev_documents_g4 VALUES(${n.tenantId},${n.projectId},'semantic-guide','v1',${content},${asOf},null)`;
		const source = {
			namespace: n, sourceId: "demo.document", id: "semantic-guide",
			version: developmentDocumentVersion({ namespace: n, id: "semantic-guide", version: "v1", content, asOf }),
			range: { start: 0, end: content.length, unit: "unicode_code_points" as const }, quote: content,
		};
		function reviewed(id: string, text: string, recordType = "team_rule"): KnowledgeRecord {
			const decision = evaluateBusinessPolicy(developmentMemoryPolicy, {
				recordType, originType: "interpretation", scopeType: "pipeline", subject: id,
				content: text, tags: ["team-rule"], createdAt: asOf, attributes: {},
			}, { authorized: true, sourceVerified: true }, new Date(asOf));
			return {
				namespace: n, id, rootId: id, version: "verified-v1", status: "verified", recordType,
				scope: "pipeline", subject: id, content: text, conditions: "Current project",
				counterexample: "Changed evidence", tags: ["team-rule"], sources: [source],
				createdAt: asOf, updatedAt: asOf, reviewBy: decision.reviewBy!, policy: decision.trace, fingerprint: id,
			};
		}
		const store = createPostgresKnowledgeStore(sql, { authorize: async () => {}, source: async () => { throw Error("unused_seed_source"); } });
		const target = reviewed("semantic-136", "Use cache eviction to keep the working set small.");
		// Simulate existing reviewed knowledge with no embeddings, including a match after row 100.
		await store.transaction(async (tx) => {
			for (let index = 0; index < 136; index++)
				await tx.saveRecord(i, reviewed("semantic-" + String(index).padStart(3, "0"), "Unrelated distractor " + index));
			await tx.saveRecord(i, target);
			for (let index = 0; index < 13; index++)
				await tx.saveRecord(i, reviewed("safety-" + String(index).padStart(3, "0"), "Mandatory constraint " + index, "constraint"));
		});
		const credential = await createServiceIdentityProvider(sql).issue(
			{ namespace: n, principalId: i.principalId }, all,
			new Date(Date.now() + 3600000).toISOString(), "synthetic-admin",
		);
		let service = await start();
		let client = createRemoteMemoryClient(service.origin, credential.token);
		const recall = { scope: "pipeline", query: "reduce memory consumption", maxBytes: 65536, retrieval: { mode: "vector", minSimilarity: 0.9 } };
		const pack = await client.request("/v1/recall", recall);
		assert.deepEqual(pack.interpretations.map((entry: any) => entry.ref.id), [target.id]);
		assert.equal(pack.constraints.length, 13);
		assert.equal(corpusCalls(), 137);
		assert.ok(!inputs.some((text) => text.includes("Mandatory constraint")));
		await client.request("/v1/recall", recall);
		assert.equal(corpusCalls(), 137);
		checks.push("configured_http_embedding_finds_semantic_match_after_row_100_lazily_indexes_old_records_and_keeps_all_constraints");
		const prepared = await client.request("/v1/use/prepare", { recall, consumerId: "demo.local-model", purpose: "semantic-review" });
		await stop(service.child);
		service = await start();
		client = createRemoteMemoryClient(service.origin, credential.token);
		assert.equal((await client.request("/v1/use/dispatch", {
			credential: prepared.use.credential, consumerId: "demo.local-model", purpose: "semantic-review",
		})).status, "dispatched");
		assert.equal(deliveries.length, 1);
		await client.request("/v1/recall", recall);
		assert.equal(corpusCalls(), 137);
		checks.push("vector_cache_and_guarded_remote_use_survive_service_process_restart");
		const unmatched = await client.request("/v1/recall", { ...recall, query: "an unrelated task" });
		assert.equal(unmatched.interpretations.length, 0);
		assert.equal(unmatched.constraints.length, 13);
		const hybrid = await client.request("/v1/recall", { ...recall, query: "Unrelated distractor", retrieval: { mode: "hybrid", minSimilarity: 0.9 } });
		assert.equal(hybrid.interpretations.length, 12);
		assert.equal(hybrid.constraints.length, 13);
		checks.push("vector_threshold_rejects_unrelated_interpretations_and_hybrid_can_retain_keyword_matches");
		const updated = { ...target, content: "Store enough diagnostic logs.", version: "verified-v2" };
		await store.transaction((tx) => tx.saveRecord(i, updated));
		await sql`UPDATE demo_dev_source_grants_g4 SET denied=true WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND principal_id=${i.principalId}`;
		const denied = await client.request("/v1/recall", recall);
		assert.equal(denied.interpretations.length, 0);
		assert.equal(denied.constraints.length, 0);
		assert.equal(corpusCalls(), 137);
		await sql`UPDATE demo_dev_source_grants_g4 SET denied=false WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND principal_id=${i.principalId}`;
		assert.equal((await client.request("/v1/recall", recall)).interpretations.length, 0);
		assert.equal(corpusCalls(), 138);
		assert.deepEqual((await client.request("/v1/recall", { ...recall, query: "inspect diagnostic traces" })).interpretations.map((entry: any) => entry.ref.id), [target.id]);
		checks.push("source_denial_prevents_record_embedding_egress_and_content_changes_invalidate_cached_vectors");
		await stop(service.child);
		service = await start("synthetic-model-b");
		client = createRemoteMemoryClient(service.origin, credential.token);
		await client.request("/v1/recall", { ...recall, query: "inspect diagnostic traces" });
		assert.equal(corpusCalls(), 275);
		providerFails = true;
		await assert.rejects(() => client.request("/v1/recall", recall), (error: any) => error.code === "embedding_unavailable" && error.status === 503);
		providerFails = false;
		checks.push("changing_configured_model_reindexes_qualified_records_and_provider_outage_is_not_empty_success");
	} finally {
		for (const child of children) {
			if (child.exitCode !== null) continue;
			child.kill();
			await once(child, "exit").catch(() => {});
		}
		stub.closeAllConnections();
		await new Promise<void>((resolve) => stub.close(() => resolve()));
	}
}

/** Storage acceptance uses a caller-created disposable database and no remote model. */
async function main() {
	const url = process.env.MEMORY_DEMO_DATABASE_URL;
	assert.ok(url);
	assert.match(new URL(url).pathname, /^\/zhiyu_test_[a-f0-9]{32}$/);
	let sql = postgres(url, { max: 2, onnotice: () => {} });
	const checks: string[] = [];
	const identity = (tenantId = "tenant-a", projectId = "project-a"): Identity => ({
		namespace: { tenantId, projectId },
		principalId: "reader",
		traceId: "storage-acceptance",
	});
	const primary = identity(),
		otherProject = identity("tenant-a", "project-b"),
		otherTenant = identity("tenant-b", "project-a");
	const record = (i: Identity, id: string, scope = "team"): KnowledgeRecord => ({
		namespace: i.namespace,
		id,
		rootId: id,
		version: "version-1",
		status: "verified",
		recordType: "rule",
		scope,
		subject: "Stored rule",
		content: "Semantic memory \u8bb0\u5fc6 \ud83e\udded " + id,
		conditions: "Current project",
		counterexample: "Changed evidence",
		tags: ["team-rule"],
		sources: [],
		createdAt: "2026-10-21T00:00:00.000Z",
		updatedAt: "2026-10-21T00:00:00.000Z",
		reviewBy: "2027-01-01T00:00:00.000Z",
		policy: {
			id: "storage-policy",
			version: "1",
			inputHash: "a".repeat(64),
			decisionHash: "b".repeat(64),
			inputSummary: {
				recordType: "rule",
				scopeType: scope,
				contentHash: "c".repeat(64),
				createdAt: "2026-10-21T00:00:00.000Z",
			},
		},
		fingerprint: i.namespace.tenantId + ":" + i.namespace.projectId + ":" + id,
	});
	const ports = {
		authorize: async () => {},
		source: async () => { throw Error("unused_source_adapter"); },
	};
	try {
		// Reproduce the pre-vector table layout before an explicit schema upgrade.
		await sql`CREATE TABLE general_memory_knowledge_g4 (
      tenant_id text NOT NULL,project_id text NOT NULL,id text NOT NULL,scope text NOT NULL,fingerprint text NOT NULL,record jsonb NOT NULL,
      PRIMARY KEY(tenant_id,project_id,id))`;
		const initial = record(primary, "entry-000");
		await sql`INSERT INTO general_memory_knowledge_g4 VALUES(${primary.namespace.tenantId},${primary.namespace.projectId},${initial.id},${initial.scope},${initial.fingerprint},${sql.json(initial as any)})`;
		await initializeKnowledgeSchema(sql);
		await initializeKnowledgeSchema(sql);
		let store = createPostgresKnowledgeStore(sql, ports);
		await store.transaction(async (tx) => {
			assert.deepEqual(await tx.record(primary, initial.id, "share"), initial);
			for (let index = 0; index < 137; index++)
				await tx.saveRecord(primary, record(primary, "entry-" + String(index).padStart(3, "0")));
			await tx.saveRecord(primary, record(primary, "other-scope", "private"));
			await tx.saveRecord(otherProject, record(otherProject, "entry-000"));
			await tx.saveRecord(otherTenant, record(otherTenant, "entry-000"));
		});
		checks.push("explicit_schema_upgrade_is_idempotent_and_preserves_existing_records");
		await store.transaction(async (tx) => {
			assert.ok(tx.scan);
			const ids: string[] = [];
			let afterId: string | undefined;
			for (;;) {
				const page = await tx.scan(primary, "team", afterId, 31);
				if (!page.length) break;
				for (const item of page) {
					assert.deepEqual(item.namespace, primary.namespace);
					assert.equal(item.scope, "team");
					ids.push(item.id);
				}
				afterId = page[page.length - 1].id;
			}
			assert.equal(ids.length, 137);
			assert.equal(new Set(ids).size, 137);
			assert.deepEqual(ids, [...ids].sort());
			assert.equal(ids.at(-1), "entry-136");
			assert.equal((await tx.scan(otherProject, "team", undefined, 100)).length, 1);
			assert.equal((await tx.scan(otherTenant, "team", undefined, 100)).length, 1);
			assert.equal((await tx.scan(primary, "private", undefined, 100))[0].id, "other-scope");
			assert.equal((await tx.scan(primary, "team", "entry-136", 100)).length, 0);
			assert.equal((await tx.scan(primary, "missing", undefined, 100)).length, 0);
		});
		for (const limit of [0, -1, 1.5, Infinity, 1001])
			await assert.rejects(() => store.transaction((tx) => tx.scan!(primary, "team", undefined, limit)), /invalid_knowledge_scan_limit/);
		checks.push("stable_cursor_scan_reaches_records_after_100_and_isolates_namespace_and_scope");
		const [before] = await sql`SELECT count(*)::integer AS count FROM general_memory_knowledge_history_g4`;
		await store.transaction(async (tx) => {
			assert.ok(tx.embeddings);
			const cache = tx.embeddings;
			assert.equal(await cache.get(primary, "entry-000", "model-a:3", "input-1"), null);
			await cache.put(primary, "entry-000", "model-a:3", "input-1", [0.25, -0.5, 1]);
			assert.deepEqual(await cache.get(primary, "entry-000", "model-a:3", "input-1"), [0.25, -0.5, 1]);
			assert.equal(await cache.get(primary, "entry-000", "model-a:3", "changed-input"), null);
			assert.equal(await cache.get(primary, "entry-000", "model-b:3", "input-1"), null);
			assert.equal(await cache.get(otherProject, "entry-000", "model-a:3", "input-1"), null);
			assert.equal(await cache.get(otherTenant, "entry-000", "model-a:3", "input-1"), null);
			await cache.put(otherProject, "entry-000", "model-a:3", "input-1", [2, 3, 4]);
			await cache.put(otherTenant, "entry-000", "model-a:3", "input-1", [4, 5, 6]);
			await cache.put(primary, "entry-000", "model-b:2", "input-1", [1, 2]);
			await cache.put(primary, "entry-000", "model-a:3", "input-2", [1, 0, -1]);
			assert.equal(await cache.get(primary, "entry-000", "model-a:3", "input-1"), null);
			assert.deepEqual(await cache.get(primary, "entry-000", "model-a:3", "input-2"), [1, 0, -1]);
			assert.deepEqual(await cache.get(primary, "entry-000", "model-b:2", "input-1"), [1, 2]);
			assert.deepEqual(await cache.get(otherProject, "entry-000", "model-a:3", "input-1"), [2, 3, 4]);
			assert.deepEqual(await cache.get(otherTenant, "entry-000", "model-a:3", "input-1"), [4, 5, 6]);
			assert.deepEqual(await tx.record(primary, initial.id, "share"), initial);
		});
		const [after] = await sql`SELECT count(*)::integer AS count FROM general_memory_knowledge_history_g4`;
		assert.equal(after.count, before.count);
		const [arrayType] = await sql`SELECT pg_typeof(vector)::text AS type, array_ndims(vector) AS dimensions FROM general_memory_embeddings_g6 LIMIT 1`;
		assert.equal(arrayType.type, "double precision[]");
		assert.equal(arrayType.dimensions, 1);
		checks.push("persistent_vector_cache_isolates_namespaces_models_and_input_hashes_without_changing_governance_history");
		for (const vector of [[], [Infinity], [NaN]])
			await assert.rejects(() => store.transaction((tx) => tx.embeddings!.put(primary, "entry-000", "bad", "input", vector)), /invalid_embedding_vector/);
		await assert.rejects(() => store.transaction(async (tx) => {
			await tx.embeddings!.put(primary, "entry-001", "rolled-back", "input", [1, 2]);
			throw Error("rollback_expected");
		}), /rollback_expected/);
		assert.equal(await store.transaction((tx) => tx.embeddings!.get(primary, "entry-001", "rolled-back", "input")), null);
		checks.push("vector_writes_reject_nonfinite_values_and_follow_transaction_rollback");
		await sql.end();
		sql = postgres(url, { max: 2, onnotice: () => {} });
		store = createPostgresKnowledgeStore(sql, ports);
		await store.transaction(async (tx) => {
			assert.deepEqual(await tx.embeddings!.get(primary, "entry-000", "model-a:3", "input-2"), [1, 0, -1]);
			assert.deepEqual(await tx.embeddings!.get(primary, "entry-000", "model-b:2", "input-1"), [1, 2]);
			const [saved] = await tx.scan!(primary, "team", "entry-135", 100);
			assert.equal(saved.id, "entry-136");
			assert.ok(saved.content.includes("\u8bb0\u5fc6 \ud83e\udded"));
			assert.ok(!saved.content.includes("\ufffd"));
		});
		checks.push("vectors_and_unicode_records_survive_connection_restart");
		await remoteVectorAcceptance(sql, url, checks);
		const result = { passed: true, checks, realProviderCalled: false, storage: "postgres_double_precision_array" };
		if (process.env.MEMORY_DEMO_RESULT)
			fs.writeFileSync(process.env.MEMORY_DEMO_RESULT, JSON.stringify(result, null, 2));
		console.log(JSON.stringify(result));
	} finally {
		await sql.end();
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
