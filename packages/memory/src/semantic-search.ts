import { MemoryError } from "./contracts";
import { digest } from "./core";
import {
	embedTexts,
	normalizeEmbedding,
	type EmbeddingProvider,
} from "./embeddings";
import type { KnowledgeRecord, KnowledgeTransaction } from "./knowledge-contracts";
import type { Identity } from "./ports";
import { fail, keys, object } from "./validation";

export type RetrievalMode = "keyword" | "vector" | "hybrid";
export type SemanticSearch = {
	provider: EmbeddingProvider;
	defaultMode?: RetrievalMode;
	minSimilarity?: number;
};

export function parseRetrieval(value: unknown, settings?: SemanticSearch) {
	const input = value === undefined ? {} : object(value);
	keys(input, ["mode", "minSimilarity"]);
	const mode = input.mode ?? settings?.defaultMode ?? "keyword";
	if (mode !== "keyword" && mode !== "vector" && mode !== "hybrid")
		fail("invalid_request");
	const minSimilarity = input.minSimilarity ?? settings?.minSimilarity ?? 0.3;
	if (
		typeof minSimilarity !== "number" ||
		!Number.isFinite(minSimilarity) ||
		minSimilarity < -1 ||
		minSimilarity > 1
	)
		fail("invalid_request");
	if (mode === "keyword" && input.minSimilarity !== undefined) fail("invalid_request");
	if (mode !== "keyword" && !settings)
		fail("semantic_search_unavailable", 422);
	return { mode, minSimilarity };
}

/** Exact cosine scan. Only qualified records may cross the embedding provider interface. */
export async function retrieveKnowledge(input: {
	tx: KnowledgeTransaction;
	identity: Identity;
	scope: string;
	query: string;
	retrieval: ReturnType<typeof parseRetrieval>;
	settings?: SemanticSearch;
	qualify(record: KnowledgeRecord): Promise<void>;
	/** Synchronous deadline checks after all lock waits; authority rows stay locked. */
	checkCurrent(record: KnowledgeRecord): void;
}) {
	const { tx, identity, scope, query, retrieval, settings } = input;
	const omissions: Array<{ id: string; reason: string }> = [];
	let omissionCount = 0;
	function omit(id: string, reason: string) {
		omissionCount++;
		if (omissions.length < 8) omissions.push({ id, reason });
	}
	const ranked: Array<{ record: KnowledgeRecord; score: number }> = [];
	async function qualify(record: KnowledgeRecord) {
		if (
			record.namespace.tenantId !== identity.namespace.tenantId ||
			record.namespace.projectId !== identity.namespace.projectId ||
			record.scope !== scope
		)
			fail("knowledge_namespace_mismatch", 503);
		try {
			await input.qualify(record);
			return true;
		} catch (error) {
			if (!(error instanceof MemoryError) || error.status >= 500) throw error;
			omit(record.id, error.code);
			return false;
		}
	}
	function current(record: KnowledgeRecord) {
		try {
			input.checkCurrent(record);
			return true;
		} catch (error) {
			if (!(error instanceof MemoryError) || error.status >= 500) throw error;
			omit(record.id, error.code);
			return false;
		}
	}
	if (retrieval.mode === "keyword") {
		for (const record of await tx.list(identity, scope, 100)) {
			if (await qualify(record))
				ranked.push({ record, score: Number(record.content.includes(query)) });
		}
	} else {
		if (!settings || !tx.scan || !tx.embeddings)
			fail("semantic_search_unavailable", 422);
		const provider = settings.provider;
		const spaceId = digest([
			"knowledge-embedding.v1", provider.id, provider.dimensions,
		]);
		const [queryVector] = await embedTexts(provider, [query]);
		let afterId: string | undefined;
		const cursors = new Set<string>();
		while (true) {
			const page = await tx.scan(identity, scope, afterId, 100);
			if (!page.length) break;
			if (page.length > 100) fail("invalid_search_scan", 503);
			const pending: Array<{
				record: KnowledgeRecord; text: string; hash: string;
			}> = [];
			function rank(record: KnowledgeRecord, vector: number[]) {
				const similarity = Math.max(-1, Math.min(1,
					vector.reduce((sum, v, i) => sum + v * queryVector[i], 0),
				));
				const lexical = record.content.includes(query);
				if (
					similarity >= retrieval.minSimilarity ||
					(retrieval.mode === "hybrid" && lexical)
				) {
					ranked.push({
						record,
						score: similarity + (retrieval.mode === "hybrid" && lexical ? 0.25 : 0),
					});
				}
			}
			for (const record of page) {
				if (!(await qualify(record))) continue;
				// Mandatory constraints bypass relevance scores and do not need document vectors.
				if (record.recordType === "constraint") {
					ranked.push({ record, score: 0 });
					continue;
				}
				const text = JSON.stringify([
					record.subject, record.content, record.conditions, record.counterexample,
				]);
				const hash = digest(text);
				const cached = await tx.embeddings.get(identity, record.id, spaceId, hash);
				if (cached)
					rank(record, normalizeEmbedding(cached, provider.dimensions));
				else pending.push({ record, text, hash });
			}
			for (let offset = 0; offset < pending.length; offset += 32) {
				// A previous model call can outlive a credential or source deadline.
				await tx.authorize(identity, "recall");
				const batch: typeof pending = [];
				for (const item of pending.slice(offset, offset + 32)) {
					if (await qualify(item.record)) batch.push(item);
				}
				await tx.authorize(identity, "recall");
				const ready = batch.filter((item) => current(item.record));
				if (!ready.length) continue;
				const vectors = await embedTexts(
					provider, ready.map((item) => item.text),
				);
				for (let index = 0; index < ready.length; index++) {
					const { record, hash } = ready[index];
					await tx.embeddings.put(
						identity, record.id, spaceId, hash, vectors[index],
					);
					rank(record, vectors[index]);
				}
			}
			const cursor = page[page.length - 1].id;
			if (cursors.has(cursor)) fail("invalid_search_scan", 503);
			cursors.add(cursor);
			afterId = cursor;
			if (page.length < 100) break;
		}
	}
	if (retrieval.mode !== "keyword") {
		await tx.authorize(identity, "recall");
		for (let index = ranked.length - 1; index >= 0; index--) {
			if (!(await qualify(ranked[index].record))) ranked.splice(index, 1);
		}
		// Recheck credential expiry after all final source lock waits as well.
		await tx.authorize(identity, "recall");
		for (let index = ranked.length - 1; index >= 0; index--) {
			if (!current(ranked[index].record)) ranked.splice(index, 1);
		}
	}
	ranked.sort((a, b) =>
		b.score - a.score || a.record.id.localeCompare(b.record.id),
	);
	return {
		ranked: ranked.map((item) => item.record), omissions, omissionCount,
	};
}
