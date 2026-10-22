import test from "node:test";
import assert from "node:assert/strict";
import { MemoryError } from "../src/contracts";
import type { EmbeddingProvider } from "../src/embeddings";
import { createKnowledgeHost } from "../src/knowledge";
import type {
	KnowledgeAudit,
	KnowledgeRecord,
	KnowledgeSource,
	KnowledgeTransaction,
} from "../src/knowledge-contracts";
import { evaluateBusinessPolicy } from "../src/policy";
import { developmentMemoryPolicy } from "../../../examples/memory-project/policy";

const namespace = { tenantId: "tenant", projectId: "project" },
	createdAt = "2026-10-21T00:00:00Z",
	now = () => new Date(createdAt),
	policy = evaluateBusinessPolicy(
		developmentMemoryPolicy,
		{
			recordType: "rule",
			originType: "interpretation",
			scopeType: "team",
			subject: "Release gate",
			content: "Verify build before shipping.",
			tags: ["team-rule"],
			createdAt,
			attributes: {},
		},
		{},
		now(),
	);

function record(id: string, patch: Partial<KnowledgeRecord> = {}): KnowledgeRecord {
	return {
		namespace,
		id,
		rootId: id,
		version: `version:${id}`,
		status: "verified",
		recordType: "rule",
		scope: "team",
		subject: "Release gate",
		content: "Verify build before shipping.",
		conditions: "Before a production release",
		counterexample: "A development-only run",
		tags: ["team-rule"],
		createdAt,
		updatedAt: createdAt,
		reviewBy: policy.reviewBy!,
		policy: policy.trace,
		fingerprint: `fingerprint:${id}`,
		sources: [{
			namespace,
			sourceId: "doc",
			id: `source:${id}`,
			version: "v1",
			quote: "guide",
			range: { start: 0, end: 5, unit: "unicode_code_points" },
		}],
		...patch,
	};
}

function semanticText(r: KnowledgeRecord) {
	return JSON.stringify([r.subject, r.content, r.conditions, r.counterexample]);
}

/** Explicit numerical fixtures model meaning without a production hash fallback. */
function provider(
	vectors: ReadonlyMap<string, number[]> = new Map(),
	options: {
		id?: string;
		dimensions?: number;
		fallback?: number[];
		onEmbed?: (inputs: readonly string[], call: number) => void;
	} = {},
) {
	const calls: string[][] = [],
		model: EmbeddingProvider = {
			id: options.id ?? "fixture/semantic-v1",
			dimensions: options.dimensions ?? 3,
			async embed(inputs) {
				calls.push([...inputs]);
				options.onEmbed?.(inputs, calls.length);
				return inputs.map((input) => [
					...(vectors.get(input) ?? options.fallback ?? [1, 0, 0]),
				]);
			},
		};
	return { model, calls };
}

function fixture(
	records: KnowledgeRecord[],
	options: {
		model?: EmbeddingProvider;
		semanticSearch?: boolean;
		defaultMode?: "keyword" | "vector" | "hybrid";
		minSimilarity?: number;
	} = {},
) {
	const model = options.model ?? provider().model,
		sources = new Map<string, KnowledgeSource>(),
		sourceErrors = new Map<string, Error>(),
		cache = new Map<string, number[]>(),
		audits: KnowledgeAudit[] = [],
		cacheWrites: Array<{ recordId: string; spaceId: string; inputHash: string; vector: number[] }> = [],
		scans: Array<{ afterId: string | undefined; limit: number }> = [],
		controls: { authorityError?: Error; time: string } = { time: createdAt };
	for (const r of records)
		for (const ref of r.sources)
			sources.set(ref.id, { ...ref, content: "guide", asOf: createdAt });
	const sorted = (scope: string) => records
		.filter((r) => r.scope === scope &&
			r.namespace.tenantId === namespace.tenantId &&
			r.namespace.projectId === namespace.projectId)
		.sort((a, b) => a.id.localeCompare(b.id));
	const tx: Partial<KnowledgeTransaction> = {
		async authorize() {
			if (controls.authorityError) throw controls.authorityError;
		},
		async list(_identity, scope, limit) {
			return sorted(scope).slice(0, limit);
		},
		async scan(_identity, scope, afterId, limit) {
			scans.push({ afterId, limit });
			return sorted(scope)
				.filter((r) => !afterId || r.id.localeCompare(afterId) > 0)
				.slice(0, limit);
		},
		embeddings: {
			async get(identity, recordId, spaceId, inputHash) {
				return cache.get(JSON.stringify([identity.namespace, recordId, spaceId, inputHash])) ?? null;
			},
			async put(identity, recordId, spaceId, inputHash, vector) {
				cacheWrites.push({ recordId, spaceId, inputHash, vector: [...vector] });
				cache.set(JSON.stringify([identity.namespace, recordId, spaceId, inputHash]), [...vector]);
			},
		},
		async source(_identity, ref) {
			const error = sourceErrors.get(ref.id);
			if (error) throw error;
			const source = sources.get(ref.id);
			assert.ok(source, `Missing fixture source ${ref.id}`);
			return source;
		},
		async audit(_identity, audit) {
			audits.push(audit);
		},
	};
	return {
		records, sources, sourceErrors, cache, cacheWrites, audits, scans, controls,
		async client(currentModel = model) {
			return createKnowledgeHost({
				store: {
					provider: "semantic-contract-test",
					transaction: async (work) => work(tx as KnowledgeTransaction),
				},
				sources: [{ id: "doc", adapterVersion: "1", kind: "document", trustLevel: "stored" }],
				policy: developmentMemoryPolicy,
				consumers: {},
				now: () => new Date(controls.time),
				...(options.semanticSearch === false ? {} : {
					semanticSearch: {
						provider: currentModel,
						defaultMode: options.defaultMode,
						minSimilarity: options.minSimilarity,
					},
				}),
			}, async () => ({ namespace, principalId: "person", traceId: "trace" })).forSession({});
		},
	};
}

const ids = (pack: { interpretations: Array<{ ref: { id: string } }> }) =>
	pack.interpretations.map((entry) => entry.ref.id);

test("vector recall finds semantic overlap without literal overlap and applies cosine threshold", async () => {
	const related = record("related"),
		unrelated = record("unrelated", { content: "Water the indoor plants." }),
		query = "deployment checklist",
		p = provider(new Map([
			[query, [1, 0, 0]],
			[semanticText(related), [0.9, 0.1, 0]],
			[semanticText(unrelated), [0, 1, 0]],
		])),
		f = fixture([unrelated, related], { model: p.model }),
		client = await f.client();
	assert.equal(semanticText(related).includes(query), false);
	const pack = await client.recall({ scope: "team", query, retrieval: { mode: "vector", minSimilarity: 0.8 } });
	assert.deepEqual(ids(pack), ["related"]);
	assert.equal(f.audits.length, 1);
});

test("hybrid recall includes a literal hit below the semantic threshold", async () => {
	const literal = record("literal", { content: "Follow the deployment checklist." }),
		related = record("related"),
		query = "deployment checklist",
		p = provider(new Map([
			[query, [1, 0, 0]],
			[semanticText(literal), [0, 1, 0]],
			[semanticText(related), [1, 0, 0]],
		])),
		client = await fixture([literal, related], { model: p.model }).client();
	const vector = await client.recall({ scope: "team", query, retrieval: { mode: "vector", minSimilarity: 0.8 } }),
		hybrid = await client.recall({ scope: "team", query, retrieval: { mode: "hybrid", minSimilarity: 0.8 } });
	assert.deepEqual(ids(vector), ["related"]);
	assert.deepEqual(new Set(ids(hybrid)), new Set(["literal", "related"]));
});

test("semantic scores use cosine similarity rather than raw vector magnitude", async () => {
	const aligned = record("aligned"), large = record("large", { content: "Another release practice." }),
		query = "deployment checklist", p = provider(new Map([
			[query, [3, 0, 0]],
			[semanticText(aligned), [1, 0, 0]],
			[semanticText(large), [100, 100, 0]],
		])), client = await fixture([large, aligned], { model: p.model }).client();
	assert.deepEqual(ids(await client.recall({ scope: "team", query, retrieval: { mode: "vector", minSimilarity: 0.8 } })), ["aligned"]);
});

test("configured semantic defaults apply when retrieval is omitted", async () => {
	const r = record("unrelated"),
		query = "office plants",
		p = provider(new Map([[query, [0, 1, 0]], [semanticText(r), [1, 0, 0]]])),
		client = await fixture([r], { model: p.model, defaultMode: "vector", minSimilarity: 0.7 }).client();
	assert.deepEqual(ids(await client.recall({ scope: "team", query })), []);
	assert.ok(p.calls.length > 0);
});

test("keyword remains the default and preserves legacy ranking without embedding calls", async () => {
	const other = record("a-other", { content: "Water the plants." }),
		literal = record("z-literal", { content: "Follow the deployment checklist." }),
		p = provider(),
		client = await fixture([other, literal], { model: p.model }).client();
	assert.deepEqual(ids(await client.recall({ scope: "team", query: "deployment checklist" })), ["z-literal", "a-other"]);
	assert.deepEqual(p.calls, []);
	assert.deepEqual(ids(await client.recall({ scope: "team", query: "deployment checklist", retrieval: { mode: "keyword" } })), ["z-literal", "a-other"]);
	assert.deepEqual(p.calls, []);
});

test("semantic mode fails explicitly when no embedding provider is installed", async () => {
	const f = fixture([record("rule")], { semanticSearch: false }), client = await f.client();
	await assert.rejects(() => client.recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } }),
		(error) => error instanceof MemoryError && error.code === "semantic_search_unavailable" && error.status === 422);
	assert.equal(f.audits.length, 0);
});

test("callers cannot inject raw vectors or unknown retrieval settings", async () => {
	const p = provider(), f = fixture([record("rule")], { model: p.model }), client = await f.client();
	for (const retrieval of [
		{ mode: "vector", vector: [1, 0, 0] },
		{ mode: "vector", queryEmbedding: [1, 0, 0] },
		{ mode: "approximate" },
		{ mode: "vector", minSimilarity: NaN },
		{ mode: "vector", minSimilarity: 1.01 },
		{ mode: "vector", minSimilarity: -1.01 },
	]) await assert.rejects(() => client.recall({ scope: "team", query: "deployment", retrieval }),
		(error) => error instanceof MemoryError && error.code === "invalid_request");
	await assert.rejects(() => client.recall({ scope: "team", query: "deployment", vector: [1, 0, 0] }),
		(error) => error instanceof MemoryError && error.code === "invalid_request");
	assert.equal(f.audits.length, 0);
	assert.deepEqual(p.calls, []);
});

test("embedding output must contain finite nonzero vectors of the configured dimension", async () => {
	for (const invalid of [[0, 0, 0], [NaN, 0, 1], [Infinity, 0, 1], [1, 0]]) {
		const p = provider(new Map(), { fallback: invalid }), f = fixture([record("rule")], { model: p.model }), client = await f.client();
		await assert.rejects(() => client.recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } }),
			(error) => error instanceof MemoryError && error.status >= 500);
		assert.equal(f.audits.length, 0);
	}
	const malformed: EmbeddingProvider = { id: "bad-count", dimensions: 3, embed: async () => [] },
		f = fixture([record("rule")], { model: malformed }), client = await f.client();
	await assert.rejects(() => client.recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } }),
		(error) => error instanceof MemoryError && error.status >= 500);
	assert.equal(f.audits.length, 0);
});

test("record embeddings are normalized and a warm recall only embeds the query", async () => {
	const r = record("rule"), query = "deployment checklist",
		p = provider(new Map([[query, [1, 0, 0]], [semanticText(r), [3, 4, 0]]])),
		f = fixture([r], { model: p.model }), client = await f.client(),
		input = { scope: "team", query, retrieval: { mode: "vector", minSimilarity: 0.5 } };
	assert.deepEqual(ids(await client.recall(input)), ["rule"]);
	assert.equal(f.cacheWrites.length, 1);
	assert.ok(Math.abs(f.cacheWrites[0].vector[0] - 0.6) < 1e-12);
	assert.ok(Math.abs(f.cacheWrites[0].vector[1] - 0.8) < 1e-12);
	p.calls.length = 0;
	assert.deepEqual(ids(await client.recall(input)), ["rule"]);
	assert.deepEqual(p.calls.flat(), [query]);
	assert.equal(f.cacheWrites.length, 1);
});

test("cache invalidates when embedding model, dimensions, or record input changes", async () => {
	const r = record("rule"), query = "deployment checklist", first = provider(),
		f = fixture([r], { model: first.model }),
		input = { scope: "team", query, retrieval: { mode: "vector", minSimilarity: 0.8 } };
	await (await f.client()).recall(input);
	const changedModel = provider(new Map([[semanticText(r), [0, 1, 0]]]), { id: "fixture/semantic-v2" });
	assert.deepEqual(ids(await (await f.client(changedModel.model)).recall(input)), []);
	assert.ok(changedModel.calls.flat().includes(semanticText(r)));
	const changedDimensions = provider(new Map([[semanticText(r), [0, 1, 0, 0]]]), {
		id: changedModel.model.id, dimensions: 4, fallback: [1, 0, 0, 0],
	});
	assert.deepEqual(ids(await (await f.client(changedDimensions.model)).recall(input)), []);
	assert.ok(changedDimensions.calls.flat().includes(semanticText(r)));
	r.content = "A revised release procedure.";
	changedDimensions.calls.length = 0;
	assert.deepEqual(ids(await (await f.client(changedDimensions.model)).recall(input)), ["rule"]);
	assert.ok(changedDimensions.calls.flat().includes(semanticText(r)));
	assert.equal(new Set(f.cacheWrites.map((write) => write.spaceId)).size, 3);
	assert.notEqual(f.cacheWrites[2].inputHash, f.cacheWrites[3].inputHash);
});

test("a corrupt cached vector causes explicit failure without a successful recall audit", async () => {
	const f = fixture([record("rule")]), client = await f.client(),
		input = { scope: "team", query: "deployment", retrieval: { mode: "vector" } };
	await client.recall(input);
	assert.equal(f.cache.size, 1);
	for (const key of f.cache.keys()) f.cache.set(key, [0, 0, 0]);
	const auditsBefore = f.audits.length;
	await assert.rejects(() => client.recall(input),
		(error) => error instanceof MemoryError && error.status >= 500);
	assert.equal(f.audits.length, auditsBefore);
});

test("governance and current source checks withhold record text before embedding", async () => {
	const allowed = record("allowed"),
		rejected = record("rejected", { status: "rejected", content: "Rejected sensitive interpretation." }),
		expired = record("expired", { reviewBy: "2026-10-20T00:00:00Z", content: "Expired sensitive interpretation." }),
		revoked = record("revoked", { content: "Revoked sensitive interpretation." }),
		changed = record("changed", { content: "Changed-source sensitive interpretation." }),
		p = provider(), f = fixture([allowed, rejected, expired, revoked, changed], { model: p.model });
	f.sourceErrors.set(revoked.sources[0].id, new MemoryError("source_denied", 403, "revoked"));
	f.sources.get(changed.sources[0].id)!.version = "v2";
	const pack = await (await f.client()).recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } });
	assert.deepEqual(ids(pack), ["allowed"]);
	for (const r of [rejected, expired, revoked, changed])
		assert.equal(p.calls.flat().includes(semanticText(r)), false, `${r.id} leaked to the embedding provider`);
	assert.deepEqual(new Set(pack.omissions.map((omission) => omission.reason)), new Set(["review_required", "expired", "source_denied", "source_changed"]));
});

test("authority rejection prevents all embedding calls", async () => {
	const p = provider(), f = fixture([record("rule")], { model: p.model }),
		error = new MemoryError("authority_denied", 403, "revoked");
	f.controls.authorityError = error;
	await assert.rejects(() => f.client().then((client) => client.recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } })), (e) => e === error);
	assert.deepEqual(p.calls, []);
	assert.equal(f.audits.length, 0);
});

test("source and embedding provider outages remain terminal without a recall success audit", async () => {
	const r = record("rule"), sourceError = new MemoryError("source_unavailable", 503, "source offline"),
		p = provider(), sourceFixture = fixture([r], { model: p.model });
	sourceFixture.sourceErrors.set(r.sources[0].id, sourceError);
	await assert.rejects(() => sourceFixture.client().then((client) => client.recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } })), (e) => e === sourceError);
	assert.equal(sourceFixture.audits.length, 0);
	assert.equal(p.calls.flat().includes(semanticText(r)), false);
	const embeddingError = new MemoryError("embedding_unavailable", 503, "embedding offline"),
		failed: EmbeddingProvider = { id: "offline", dimensions: 3, embed: async () => { throw embeddingError; } },
		embeddingFixture = fixture([r], { model: failed });
	await assert.rejects(() => embeddingFixture.client().then((client) => client.recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } })), (e) => e === embeddingError);
	assert.equal(embeddingFixture.audits.length, 0);
});

test("low-similarity safety constraints remain mandatory beyond the ordinary 12-item cap", async () => {
	const constraints = Array.from({ length: 13 }, (_, index) => record(`constraint-${index.toString().padStart(2, "0")}`, {
		recordType: "constraint", content: `Safety condition ${index}.`,
	})), query = "deployment checklist",
		vectors = new Map(constraints.map((r) => [semanticText(r), [0, 1, 0]]));
	vectors.set(query, [1, 0, 0]);
	const f = fixture(constraints, { model: provider(vectors).model }), client = await f.client(),
		pack = await client.recall({ scope: "team", query, maxBytes: 65536, retrieval: { mode: "vector", minSimilarity: 0.99 } });
	assert.deepEqual(new Set(pack.constraints.map((entry) => entry.ref.id)), new Set(constraints.map((r) => r.id)));
	assert.equal(pack.constraints.some((entry) => entry.truncated), false);
	const auditsBefore = f.audits.length;
	await assert.rejects(() => client.recall({ scope: "team", query, maxBytes: 512, retrieval: { mode: "vector", minSimilarity: 0.99 } }),
		(error) => error instanceof MemoryError && error.code === "budget_exceeded" && error.status === 409);
	assert.equal(f.audits.length, auditsBefore);
});

test("semantic recall scans beyond the first 100 records to find the best hit", async () => {
	const records = Array.from({ length: 101 }, (_, index) => record(`rule-${index.toString().padStart(3, "0")}`, {
		content: `Procedure number ${index}.`,
	})), query = "deployment checklist",
		vectors = new Map(records.map((r) => [semanticText(r), [0, 1, 0]]));
	vectors.set(query, [1, 0, 0]);
	vectors.set(semanticText(records[100]), [1, 0, 0]);
	const f = fixture(records, { model: provider(vectors).model }),
		pack = await (await f.client()).recall({ scope: "team", query, retrieval: { mode: "vector", minSimilarity: 0.9 } });
	assert.deepEqual(ids(pack), ["rule-100"]);
	assert.ok(f.scans.length >= 2);
	assert.equal(f.scans[0].limit, 100);
	assert.equal(f.scans[1].afterId, "rule-099");
});

test("expiry during query embedding withholds expired knowledge before document embedding", async () => {
	const deadline = "2026-10-21T00:00:01Z",
		expiringRecord = record("record-expiry", { reviewBy: deadline }),
		expiringSource = record("source-expiry", { content: "Source has a short validity period." }),
		p = provider(new Map(), { onEmbed(_inputs, call) {
			if (call === 1) f.controls.time = "2026-10-21T00:00:02Z";
		} }),
		f = fixture([expiringRecord, expiringSource], { model: p.model });
	f.sources.get(expiringSource.sources[0].id)!.expiresAt = deadline;
	const pack = await (await f.client()).recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } });
	assert.deepEqual(ids(pack), []);
	assert.deepEqual(p.calls.flat(), ["deployment"]);
	assert.deepEqual(new Set(pack.omissions.map((omission) => omission.reason)), new Set(["expired", "source_expired"]));
});

test("expiry during the first document batch blocks later batches and removes already ranked records", async () => {
	const records = Array.from({ length: 33 }, (_, index) => record(`rule-${index.toString().padStart(2, "0")}`, {
		content: `Short-lived release advice ${index}.`,
		reviewBy: "2026-10-21T00:00:01Z",
	})),
		p = provider(new Map(), { onEmbed(_inputs, call) {
			if (call === 2) f.controls.time = "2026-10-21T00:00:02Z";
		} }),
		f = fixture(records, { model: p.model }),
		pack = await (await f.client()).recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } });
	assert.deepEqual(ids(pack), []);
	assert.equal(p.calls[1].length, 32);
	assert.equal(p.calls.flat().includes(semanticText(records[32])), false);
	assert.ok(pack.omissions.some((omission) => omission.reason === "expired"));
});

test("source expiry and revocation during document embedding prevent returned knowledge", async () => {
	const expiring = record("expiring"), revoked = record("revoked", { content: "Sensitive release permission." }),
		p = provider(new Map(), { onEmbed(_inputs, call) {
			if (call === 2) {
				f.controls.time = "2026-10-21T00:00:02Z";
				f.sourceErrors.set(revoked.sources[0].id, new MemoryError("source_denied", 403, "revoked during embedding"));
			}
		} }),
		f = fixture([expiring, revoked], { model: p.model });
	f.sources.get(expiring.sources[0].id)!.expiresAt = "2026-10-21T00:00:01Z";
	const pack = await (await f.client()).recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } });
	assert.deepEqual(ids(pack), []);
	assert.deepEqual(new Set(pack.omissions.map((omission) => omission.reason)), new Set(["source_expired", "source_denied"]));
});

test("authority revoked during query embedding blocks document embedding and success audit", async () => {
	const error = new MemoryError("authority_denied", 403, "revoked during query embedding"),
		p = provider(new Map(), { onEmbed(_inputs, call) {
			if (call === 1) f.controls.authorityError = error;
		} }),
		f = fixture([record("rule")], { model: p.model });
	await assert.rejects(() => f.client().then((client) => client.recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } })), (e) => e === error);
	assert.deepEqual(p.calls.flat(), ["deployment"]);
	assert.equal(f.audits.length, 0);
});

test("authority revoked during document embedding prevents return and later document batches", async () => {
	const records = Array.from({ length: 33 }, (_, index) => record(`rule-${index.toString().padStart(2, "0")}`, {
		content: `Release instruction ${index}.`,
	})), error = new MemoryError("authority_denied", 403, "revoked during document embedding"),
		p = provider(new Map(), { onEmbed(_inputs, call) {
			if (call === 2) f.controls.authorityError = error;
		} }),
		f = fixture(records, { model: p.model });
	await assert.rejects(() => f.client().then((client) => client.recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } })), (e) => e === error);
	assert.equal(p.calls.flat().includes(semanticText(records[32])), false);
	assert.equal(f.audits.length, 0);
});

test("thousands of withheld candidates retain bounded diagnostics and room for valid semantic results", async () => {
	const blocked = Array.from({ length: 2000 }, (_, index) => record(`blocked-${index.toString().padStart(4, "0")}`, {
		content: `Withheld interpretation ${index}.`,
		...(index % 2 === 0 ? { reviewBy: "2026-10-20T00:00:00Z" } : {}),
	})), valid = record("z-valid"), p = provider(),
		f = fixture([...blocked, valid], { model: p.model });
	for (const r of blocked)
		if (r.reviewBy === policy.reviewBy)
			f.sourceErrors.set(r.sources[0].id, new MemoryError("source_denied", 403, "revoked"));
	const pack = await (await f.client()).recall({ scope: "team", query: "deployment", retrieval: { mode: "vector" } });
	assert.deepEqual(ids(pack), ["z-valid"]);
	assert.ok(pack.omissions.length <= 8);
	assert.ok(pack.omissionSummary);
	assert.ok(pack.omissionSummary.total >= 2000);
	assert.equal(pack.omissionSummary.reported, pack.omissions.length);
	assert.ok(pack.omissionSummary.total > pack.omissionSummary.reported);
	assert.equal(pack.budget.truncated, true);
	assert.ok(pack.budget.usedUpperBound <= 8192);
	assert.deepEqual(p.calls.flat(), ["deployment", semanticText(valid)]);
});
