import test from "node:test";
import assert from "node:assert/strict";
import { MemoryError } from "../src/contracts";
import { createKnowledgeHost } from "../src/knowledge";
import type {
	KnowledgeRecord,
	KnowledgeTransaction,
} from "../src/knowledge-contracts";
import { evaluateBusinessPolicy } from "../src/policy";
import { developmentMemoryPolicy } from "../../../examples/memory-project/policy";

function fixture(error: Error) {
	const namespace = { tenantId: "tenant", projectId: "project" },
		createdAt = "2026-10-21T00:00:00Z",
		now = () => new Date(createdAt);
	let audits = 0;
	const policy = evaluateBusinessPolicy(
		developmentMemoryPolicy,
		{
			recordType: "rule",
			originType: "interpretation",
			scopeType: "team",
			subject: "Rule",
			content: "Check the job",
			tags: ["team-rule"],
			createdAt,
			attributes: {},
		},
		{},
		now(),
	);
	const record: KnowledgeRecord = {
		namespace,
		id: "rule",
		rootId: "rule",
		version: "v1",
		status: "verified",
		recordType: "rule",
		scope: "team",
		subject: "Rule",
		content: "Check the job",
		conditions: "Same job",
		counterexample: "Changed commit",
		tags: ["team-rule"],
		createdAt,
		updatedAt: createdAt,
		reviewBy: policy.reviewBy!,
		policy: policy.trace,
		fingerprint: "f",
		sources: [
			{
				namespace,
				sourceId: "doc",
				id: "guide",
				version: "v1",
				quote: "guide",
				range: { start: 0, end: 5, unit: "unicode_code_points" },
			},
		],
	};
	const tx = {
		authorize: async () => {},
		list: async () => [record],
		source: async () => {
			throw error;
		},
		audit: async () => {
			audits++;
		},
	} as unknown as KnowledgeTransaction;
	const host = createKnowledgeHost(
		{
			store: {
				provider: "contract-test",
				transaction: async (work) => work(tx),
			},
			sources: [
				{
					id: "doc",
					adapterVersion: "1",
					kind: "document",
					trustLevel: "stored",
				},
			],
			policy: developmentMemoryPolicy,
			consumers: {},
			now,
		},
		async () => ({ namespace, principalId: "person", traceId: "trace" }),
	);
	return { host, audits: () => audits };
}
test("known source denial yields explicit bounded omission without source body", async () => {
	const f = fixture(new MemoryError("source_denied", 403, "denied")),
		client = await f.host.forSession({});
	const pack = await client.recall({ scope: "team", query: "job" });
	assert.equal(pack.interpretations.length, 0);
	assert.equal(pack.omissions[0].reason, "source_denied");
	assert.equal(f.audits(), 1);
});
test("provider outage does not turn into empty successful recall", async () => {
	const error = new MemoryError(
			"source_unavailable",
			503,
			"provider unavailable",
		),
		f = fixture(error),
		client = await f.host.forSession({});
	await assert.rejects(
		() => client.recall({ scope: "team", query: "job" }),
		(e) => e === error,
	);
	assert.equal(f.audits(), 0);
});
test("database errors with a code remain terminal instead of becoming omissions", async () => {
	const error = Object.assign(new Error("database disconnected"), {
			code: "08006",
		}),
		f = fixture(error),
		client = await f.host.forSession({});
	await assert.rejects(
		() => client.recall({ scope: "team", query: "job" }),
		(e) => e === error,
	);
	assert.equal(f.audits(), 0);
});
