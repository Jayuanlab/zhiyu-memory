import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { PROTOCOL } from "../packages/memory/src/contracts";
import { digest } from "../packages/memory/src/core";
import { createHttpEmbeddingProvider, embedTexts } from "../packages/memory/src/embeddings";
import type { KnowledgeRecord } from "../packages/memory/src/knowledge-contracts";
import { developmentDocumentVersion } from "../examples/memory-project/knowledge-project";

// This is an explicit local acceptance test. It retains synthetic, approved test
// knowledge and its evidence; it never changes an existing project's records.
const execute = promisify(execFile);
const configDirectory = path.resolve(process.argv[2] ?? "private/local-memory");
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const runDirectory = path.resolve(".runtime/local-memory-test", runId);
let stage = "configuration";
const report: Record<string, unknown> = {
	schemaVersion: 1,
	runId,
	startedAt: new Date().toISOString(),
	passed: false,
	checks: [] as string[],
};
const secrets = new Set<string>();

function sanitize(value: unknown): unknown {
	if (typeof value === "string") {
		let text = value;
		for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[REDACTED]");
		return text;
	}
	if (Array.isArray(value)) return value.map(sanitize);
	if (value && typeof value === "object") return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key,
			/^(token|credential|authorization|apiKey|databaseUrl)$/i.test(key) ? "[REDACTED]" : sanitize(item),
		]),
	);
	return value;
}

async function save(name: string, value: unknown) {
	await fs.writeFile(path.join(runDirectory, name), `${JSON.stringify(sanitize(value), null, 2)}\n`, "utf8");
}

async function readJson(file: string) {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

function check(name: string) {
	(report.checks as string[]).push(name);
}

function cosine(left: number[], right: number[]) {
	assert.equal(left.length, right.length, "embedding_dimensions_must_match");
	return Math.max(-1, Math.min(1, left.reduce((sum, component, index) => sum + component * right[index], 0)));
}

async function main() {
	await fs.mkdir(runDirectory, { recursive: true });
	const service = await readJson(path.join(configDirectory, "service.json"));
	const env: Record<string, string> = service.env;
	assert.ok(env && typeof env === "object", "service_env_missing");
	const profilePath = path.join(configDirectory, "skill-profile.json");
	const profile = await readJson(profilePath);
	const writer = await readJson(path.join(configDirectory, "agent-credential.json"));
	const reviewer = await readJson(path.join(configDirectory, "reviewer-credential.json"));
	for (const secret of [writer.token, reviewer.token, env.MEMORY_SERVICE_DATABASE_URL, env.MEMORY_EMBEDDING_API_KEY]) {
		if (typeof secret === "string") secrets.add(secret);
	}
	const namespace = profile.expectedNamespace;
	assert.deepEqual(namespace, { tenantId: "local", projectId: "memory-lab" }, "local_test_namespace_required");
	assert.equal(profile.mode ?? "standard", "standard", "standard_profile_required");
	const serviceUrl = new URL(profile.baseUrl);
	assert.ok(serviceUrl.protocol === "http:" && serviceUrl.hostname === "127.0.0.1" && serviceUrl.port,
		"explicit_loopback_test_service_required");
	assert.match(profile.tokenEnv, /^[A-Za-z_][A-Za-z0-9_]*$/);
	for (const credential of [writer, reviewer]) {
		assert.equal(typeof credential.token, "string", "identity_token_required");
		assert.ok(Date.parse(credential.expiresAt) > Date.now() + 60_000, "identity_credential_expired_or_expiring");
	}
	const skillClient = path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
		"skills/zhiyu-memory/scripts/memory-client.mjs");
	await fs.access(skillClient);
	const scope = "local-memory-test";
	const identities = { writer: "local-agent", reviewer: "local-reviewer" };
	Object.assign(report, { namespace, scope, service: new URL(profile.baseUrl).origin, skillClient });

	async function call(name: string, route: string | undefined, body: unknown, role: "writer" | "reviewer" = "writer") {
		const args = [skillClient, "--config", profilePath];
		if (route) {
			const bodyFile = path.join(runDirectory, `${name}.request.json`);
			await save(`${name}.request.json`, body);
			args.push("request", route, "--body-file", bodyFile);
		} else args.push("capabilities");
		try {
			const result = await execute(process.execPath, args, {
				cwd: process.cwd(),
				env: { ...process.env, [profile.tokenEnv]: role === "writer" ? writer.token : reviewer.token },
				encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
			});
			const value = JSON.parse(result.stdout);
			await save(`${name}.response.json`, value);
			return value;
		} catch (error: unknown) {
			// The Skill already produces safe error codes; do not echo execFile's
			// command line or an arbitrary provider / database exception.
			let code = "skill_call_failed";
			try {
				const value = JSON.parse((error as { stderr?: string }).stderr ?? "{}");
				if (typeof value.code === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(value.code)) code = value.code;
			} catch { /* Keep the fixed, safe error code. */ }
			await save(`${name}.error.json`, { code });
			throw Object.assign(new Error(code), { code });
		}
	}

	stage = "capabilities";
	const capabilities = await call("capabilities", undefined, undefined);
	assert.ok(capabilities.retrieval?.modes.includes("vector"), "vector_retrieval_unavailable");
	assert.ok(capabilities.retrieval?.modes.includes("hybrid"), "hybrid_retrieval_unavailable");
	check("installed_skill_capability_discovery_and_namespace_check");
	const provider = createHttpEmbeddingProvider({
		url: env.MEMORY_EMBEDDING_URL,
		model: env.MEMORY_EMBEDDING_MODEL,
		dimensions: Number(env.MEMORY_EMBEDDING_DIMENSIONS),
		...(env.MEMORY_EMBEDDING_API_KEY ? { apiKey: env.MEMORY_EMBEDDING_API_KEY } : {}),
		timeoutMs: 60_000,
	});
	assert.equal(capabilities.retrieval.embeddingProvider, provider.id, "service_and_test_embedding_provider_mismatch");
	assert.equal(capabilities.retrieval.dimensions, provider.dimensions, "service_and_test_embedding_dimensions_mismatch");
	report.embedding = {
		model: env.MEMORY_EMBEDDING_MODEL,
		dimensions: provider.dimensions,
		providerId: provider.id,
		endpoint: new URL(env.MEMORY_EMBEDDING_URL).origin + new URL(env.MEMORY_EMBEDDING_URL).pathname,
		genuineProvider: true,
	};

	const topics = [
		{
			key: "release", subject: "生产发布的测试门禁和异常回滚",
			content: "发布生产版本前，持续集成流水线必须通过单元测试和集成测试；若发布后出现异常，应执行回滚并确认服务健康。",
			conditions: "适用于应用程序的生产环境发布。",
			counterexample: "只修改内部说明文档且没有部署操作时，不触发发布门禁。",
		},
		{
			key: "backup", subject: "数据库备份与恢复演练",
			content: "数据库每天保留一次完整备份，每周在隔离环境中恢复一次，并核对恢复后的数据完整性。",
			conditions: "适用于持久化业务数据的 PostgreSQL 数据库。",
			counterexample: "临时缓存的数据可从上游重建时，不要求执行完整备份。",
		},
		{
			key: "plants", subject: "室内绿植的浇水习惯",
			content: "室内绿植应放在有散射光的位置，待盆土表层干燥后再浇水，避免积水造成根部腐烂。",
			conditions: "适用于家庭室内养护的普通观叶植物。",
			counterexample: "水生植物不遵循盆土干燥后再浇水的规则。",
		},
	];
	const query = "新功能交付到线上前应具备哪些质量保障，出问题时如何恢复上一版？";
	assert.ok(topics.every((topic) => !topic.content.includes(query)), "semantic_query_must_not_be_a_literal_content_substring");

	stage = "real_embedding_calibration";
	// Mirror retrieval's separate query and document calls. Dynamic quantization
	// can change an input's result when it shares a batch with longer documents.
	const queryVectors = await embedTexts(provider, [query]);
	const documentVectors = await embedTexts(provider, topics.map((topic) =>
		JSON.stringify([topic.subject, topic.content, topic.conditions, topic.counterexample])));
	const vectors = [queryVectors[0], ...documentVectors];
	const scores = topics.map((topic, index) => ({ key: topic.key, cosine: cosine(vectors[0], vectors[index + 1]) }));
	const releaseScore = scores[0].cosine;
	const bestUnrelated = Math.max(...scores.slice(1).map((item) => item.cosine));
	assert.ok(releaseScore - bestUnrelated > 0.00001, "real_model_must_rank_release_above_unrelated_topics");
	const minSimilarity = (releaseScore + bestUnrelated) / 2;
	const strictSimilarity = (1 + releaseScore) / 2;
	assert.ok(strictSimilarity > releaseScore, "strict_cutoff_must_exceed_relevant_score");
	report.calibration = {
		query, literalFullQueryMatch: false, scores, minSimilarity, strictSimilarity,
		thresholdSemantics: "calibrated_on_this_synthetic_test_corpus_not_a_general_product_default",
	};
	await save("report.json", report);
	check("genuine_configured_embedding_has_expected_semantic_ordering");

	const sql = postgres(env.MEMORY_SERVICE_DATABASE_URL, { max: 1, onnotice: () => {} });
	const records: Array<{ key: string; sourceId: string; sourceVersion: string; record: KnowledgeRecord }> = [];
	try {
		stage = "synthetic_source_provisioning";
		const asOf = new Date().toISOString();
		for (const topic of topics) {
			const sourceId = `local-e2e:${runId}:${topic.key}`;
			const sourceContent = `${topic.subject}\n${topic.content}\n适用条件：${topic.conditions}\n反例：${topic.counterexample}`;
			const source = { namespace, id: sourceId, version: "v1", content: sourceContent, asOf };
			await sql.begin(async (tx) => {
				await tx`INSERT INTO demo_dev_documents_g4(tenant_id,project_id,id,version,content,as_of,expires_at)
					VALUES(${namespace.tenantId},${namespace.projectId},${sourceId},${source.version},${sourceContent},${asOf},null)`;
				for (const principalId of Object.values(identities)) {
					await tx`INSERT INTO demo_dev_source_grants_g4(tenant_id,project_id,principal_id,document_id,allowed,denied)
						VALUES(${namespace.tenantId},${namespace.projectId},${principalId},${sourceId},true,false)`;
				}
			});
			const readbacks: Array<{ content: string; version: string; as_of: Date }> = await sql`SELECT content,version,as_of FROM demo_dev_documents_g4
				WHERE tenant_id=${namespace.tenantId} AND project_id=${namespace.projectId} AND id=${sourceId}`;
			const readback = readbacks[0];
			assert.equal(readback.content, sourceContent, "source_unicode_roundtrip_failed");
			assert.ok(!readback.content.includes("\uFFFD") && !readback.content.includes("???"), "source_encoding_corrupted");
			const sourceVersion = developmentDocumentVersion(source);
			const request = {
				protocolVersion: PROTOCOL, commandId: randomUUID(), kind: "interpretation.propose",
				payload: {
					recordType: "team_rule", scope, subject: topic.subject, content: topic.content,
					conditions: topic.conditions, counterexample: topic.counterexample, tags: ["team-rule"],
					sources: [{ namespace, sourceId: "demo.document", id: sourceId, version: sourceVersion,
						range: { start: 0, end: Array.from(sourceContent).length, unit: "unicode_code_points" }, quote: sourceContent }],
				},
			};
			stage = `propose_${topic.key}_through_installed_skill`;
			const proposed = await call(`propose-${topic.key}`, "/v1/commands", request);
			assert.equal(proposed.receipt.record.status, "candidate", "proposal_must_be_candidate");
			assert.equal(proposed.receipt.record.content, topic.content, "knowledge_unicode_roundtrip_failed");
			records.push({ key: topic.key, sourceId, sourceVersion, record: proposed.receipt.record });
			const replay = await call(`replay-${topic.key}`, "/v1/commands", request);
			assert.equal(replay.receipt.id, proposed.receipt.id, "command_replay_must_reuse_receipt");
			assert.equal(replay.replayed, true, "command_replay_flag_required");
		}
		check("parameterized_source_provisioning_and_chinese_storage_roundtrip");
		check("knowledge_proposals_are_candidates_and_duplicate_commands_reuse_receipts");
		report.records = records.map(({ key, sourceId, sourceVersion, record }) => ({
			key, sourceId, sourceVersion, id: record.id, candidateVersion: record.version, subject: record.subject,
		}));

		stage = "candidate_exclusion";
		const before = await call("recall-before-review", "/v1/recall", {
			scope, query, maxBytes: 65536, retrieval: { mode: "vector", minSimilarity: -1 },
		});
		const candidateIds = new Set(records.map((item) => item.record.id));
		assert.ok(before.interpretations.every((entry: any) => !candidateIds.has(entry.ref.id)), "unreviewed_candidate_was_recalled");
		check("vector_recall_excludes_unreviewed_candidates");

		stage = "review_with_reviewer_identity";
		for (const item of records) {
			const reviewed = await call(`review-${item.key}`, "/v1/commands", {
				protocolVersion: PROTOCOL, commandId: randomUUID(), kind: "interpretation.review",
				payload: { id: item.record.id, expectedVersion: item.record.version, decision: "accept",
					reason: "本机验收使用的合成知识；已核对本轮测试来源、适用条件和反例。", evidenceConfirmed: true },
			}, "reviewer");
			assert.equal(reviewed.receipt.record.status, "verified", "review_must_activate_knowledge");
			item.record = reviewed.receipt.record;
			const current = await call(`read-${item.key}`, "/v1/read", { purpose: "current", id: item.record.id });
			assert.equal(current.status, "ok", "reviewed_knowledge_must_be_readable");
			assert.equal(current.record.status, "verified", "current_knowledge_must_be_verified");
			assert.equal(current.record.content, topics.find((topic) => topic.key === item.key)!.content, "reviewed_chinese_content_changed");
		}
		check("separate_reviewer_activates_knowledge_and_agent_reads_exact_current_content");

		const recallRequest = { scope, query, maxBytes: 65536, retrieval: { mode: "vector", minSimilarity } };
		stage = "vector_recall";
		const recalled = await call("recall-vector", "/v1/recall", recallRequest);
		const releaseId = records[0].record.id;
		const unrelatedIds = new Set(records.slice(1).map((item) => item.record.id));
		assert.ok(recalled.interpretations.some((entry: any) => entry.ref.id === releaseId), "semantic_release_hit_missing");
		assert.ok(recalled.interpretations.every((entry: any) => !unrelatedIds.has(entry.ref.id)), "unrelated_topic_passed_calibrated_cutoff");
		assert.equal(recalled.budget.truncated, false, "test_context_must_not_be_truncated");
		check("paraphrased_vector_query_finds_release_knowledge_and_filters_unrelated_topics");

		stage = "hybrid_recall";
		const hybrid = await call("recall-hybrid", "/v1/recall", { ...recallRequest,
			retrieval: { mode: "hybrid", minSimilarity } });
		assert.ok(hybrid.interpretations.some((entry: any) => entry.ref.id === releaseId), "hybrid_release_hit_missing");
		assert.ok(hybrid.interpretations.every((entry: any) => !unrelatedIds.has(entry.ref.id)), "hybrid_unrelated_topic_passed_cutoff");
		check("hybrid_recall_uses_the_same_genuine_embedding");

		stage = "strict_similarity_cutoff";
		const strict = await call("recall-strict-cutoff", "/v1/recall", { ...recallRequest,
			retrieval: { mode: "vector", minSimilarity: strictSimilarity } });
		assert.ok(strict.interpretations.every((entry: any) => !candidateIds.has(entry.ref.id)), "strict_cutoff_must_exclude_all_current_test_topics");
		check("increased_similarity_cutoff_excludes_the_same_test_topics");

		stage = "persisted_vector_cache";
		const spaceId = digest(["knowledge-embedding.v1", provider.id, provider.dimensions]);
		const stored = await sql`SELECT record_id,input_hash,vector FROM general_memory_embeddings_g6
			WHERE tenant_id=${namespace.tenantId} AND project_id=${namespace.projectId}
			AND record_id IN ${sql(Array.from(candidateIds))} AND space_id=${spaceId}`;
		assert.equal(stored.length, records.length, "all_test_vectors_must_be_persisted");
		const cachedScores = records.map(({ key, record }) => {
			const cached = stored.find((item) => item.record_id === record.id)!;
			assert.equal(cached.input_hash, digest(JSON.stringify([record.subject, record.content, record.conditions, record.counterexample])), "persisted_vector_input_digest_mismatch");
			assert.equal(cached.vector.length, provider.dimensions, "persisted_vector_dimensions_mismatch");
			return { key, recordId: record.id, cosine: cosine(vectors[0], cached.vector), dimensions: cached.vector.length };
		});
		const warm = await call("recall-vector-warm-cache", "/v1/recall", recallRequest);
		assert.deepEqual(warm.interpretations.map((entry: any) => entry.ref.id), recalled.interpretations.map((entry: any) => entry.ref.id), "warm_cache_results_changed");
		check("postgresql_contains_matching_real_vectors_and_repeated_recall_is_stable");
		report.results = {
			candidateIdsExcluded: records.map((item) => item.record.id),
			vectorHits: recalled.interpretations.map((entry: any) => ({ id: entry.ref.id, subject: entry.subject })),
			hybridHits: hybrid.interpretations.map((entry: any) => ({ id: entry.ref.id, subject: entry.subject })),
			strictCutoffHitCount: strict.interpretations.length,
			persistedVectorCount: stored.length, cachedScores,
			retainedSyntheticKnowledge: true,
		};
		report.passed = true;
		report.finishedAt = new Date().toISOString();
		await save("report.json", report);
		console.log(JSON.stringify({ passed: true, report: path.join(runDirectory, "report.json"),
			checks: report.checks, query, model: env.MEMORY_EMBEDDING_MODEL, dimensions: provider.dimensions,
			minSimilarity, scores: cachedScores, recordCount: records.length }));
	} finally {
		await sql.end({ timeout: 5 });
	}
}

try {
	await main();
} catch (error: unknown) {
	const candidate = (error as { code?: unknown }).code;
	const code = typeof candidate === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(candidate)
		? candidate : "local_memory_acceptance_failed";
	const message = (error as { message?: unknown }).message;
	const assertion = candidate === "ERR_ASSERTION" && typeof message === "string"
		? message.split("\n")[0] : undefined;
	const failedCheck = assertion && /^[a-z][a-z0-9_]{0,119}$/.test(assertion) ? assertion : undefined;
	report.failure = { stage, code, ...(failedCheck ? { failedCheck } : {}) };
	report.finishedAt = new Date().toISOString();
	await fs.mkdir(runDirectory, { recursive: true });
	await save("report.json", report);
	console.error(JSON.stringify({ passed: false, stage, code, ...(failedCheck ? { failedCheck } : {}),
		report: path.join(runDirectory, "report.json") }));
	process.exitCode = 1;
}
