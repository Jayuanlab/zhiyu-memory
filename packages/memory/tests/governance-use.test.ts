import test from "node:test";
import assert from "node:assert/strict";
import {
	assessDependencies,
	reviewTransitionIssue,
	revisionTransitionIssue,
	runGovernedCommand,
} from "../src/governance";
import {
	budgetContextPack,
	exactPrefix,
	selectRecallCandidates,
} from "../src/context";
import { createUseGuard } from "../src/use";

test("governed commands authorize before replay, conflict on changed input, and require audit", async () => {
	let authorized = true,
		executions = 0,
		stored: any = null;
	const input = {
		requestHash: "a",
		authorize: async () => {
			assert.ok(authorized);
		},
		lock: async () => {},
		prior: async () => stored,
		execute: async () => ({ id: ++executions }),
		persist: async (outcome: any) => {
			stored = { requestHash: "a", outcome, receipt: { id: "audit" } };
			return stored.receipt;
		},
		conflict: (): never => {
			throw Error("conflict");
		},
	};
	assert.equal((await runGovernedCommand(input)).replayed, false);
	assert.equal((await runGovernedCommand(input)).replayed, true);
	assert.equal(executions, 1);
	await assert.rejects(
		() => runGovernedCommand({ ...input, requestHash: "b" }),
		/conflict/,
	);
	authorized = false;
	await assert.rejects(() => runGovernedCommand(input));
	authorized = true;
	stored = null;
	await assert.rejects(
		() => runGovernedCommand({ ...input, persist: async () => null }),
		/audit_unavailable/,
	);
});
test("review and revision guards preserve CAS, retirement, evidence and owner checks", () => {
	const review = {
		currentVersion: "v1",
		expectedVersion: "v1",
		pendingProposal: false,
		activating: true,
		retired: false,
		revised: true,
		ownerReview: false,
		evidenceConfirmed: true,
		reason: "checked",
		ownerVerificationRequired: true,
	};
	assert.equal(reviewTransitionIssue(review), "revision_verification_required");
	assert.equal(reviewTransitionIssue({ ...review, ownerReview: true }), null);
	assert.equal(
		reviewTransitionIssue({ ...review, expectedVersion: "old" }),
		"version_conflict",
	);
	assert.equal(reviewTransitionIssue({ ...review, retired: true }), "retired");
	assert.equal(
		reviewTransitionIssue({ ...review, activating: false }),
		"revision_required",
	);
	assert.equal(
		revisionTransitionIssue({
			currentVersion: "v1",
			expectedVersion: "v1",
			sameIdentity: true,
			pendingProposal: false,
			restoring: true,
			restorable: false,
			retired: true,
		}),
		"inactive",
	);
});
test("denial dominates dependencies and unknown coverage never becomes current", () => {
	assert.equal(
		assessDependencies({
			recorded: false,
			entityCurrent: true,
			sourceAssessments: ["denied"],
		}),
		"denied",
	);
	assert.equal(
		assessDependencies({
			recorded: false,
			entityCurrent: true,
			sourceAssessments: ["current"],
		}),
		"unknown",
	);
	assert.equal(
		assessDependencies({
			recorded: true,
			entityCurrent: true,
			sourceAssessments: [],
		}),
		"stale",
	);
	assert.equal(
		assessDependencies({
			recorded: true,
			entityCurrent: true,
			sourceAssessments: ["current"],
		}),
		"current",
	);
});
test("recall policy keeps restrictions, deduplicates groups and reserves corrections", () => {
	const ranked = [
			{ id: "a", g: "x", priority: true, reserve: false },
			{ id: "b", g: "x", priority: false, reserve: true },
			{ id: "c", g: "y", priority: false, reserve: true },
			{ id: "d", g: "z", priority: false, reserve: false },
		],
		duplicate: string[] = [],
		reserved: string[] = [];
	const items = selectRecallCandidates({
		ranked,
		maxItems: 3,
		group: (i) => i.g,
		priority: (i) => i.priority,
		reserve: (i) => i.reserve,
		reserveLimit: 1,
		onDuplicate: (i) => duplicate.push(i.id),
		onReserved: (i) => reserved.push(i.id),
	});
	assert.deepEqual(
		items.map((i) => i.id),
		["a", "c", "d"],
	);
	assert.deepEqual(duplicate, ["b"]);
	assert.deepEqual(reserved, ["c"]);
});
test("ContextPack budgeting preserves full constraints and exact Unicode prefixes", () => {
	const p = {
		constraints: [{ content: "Never send" }],
		currentStates: [],
		historicalEvidence: [],
		interpretations: [{ content: "🧭原文".repeat(300) }],
		openQuestions: [],
		budget: {
			maxTokens: 600,
			usedUpperBound: 0,
			unit: "utf8_bytes_upper_bound" as const,
			truncated: false,
		},
	};
	const result = budgetContextPack(p)!;
	assert.deepEqual(result.constraints, p.constraints);
	assert.ok(result.budget.truncated);
	assert.ok(
		exactPrefix(
			p.interpretations[0].content,
			result.interpretations[0].content,
		),
	);
	assert.equal(
		budgetContextPack({ ...p, budget: { ...p.budget, maxTokens: 5 } }),
		null,
	);
	assert.equal(exactPrefix("🧭", "\ud83e"), false);
});

type Selection = {
	key: string;
	refs: Array<{ identity: string; version: string }>;
};
function fixture() {
	let version = "v1",
		allowed = true,
		audits = 0,
		onAdmission: undefined | (() => Promise<void>);
	const issued = new WeakSet<object>();
	const guard = createUseGuard<Selection, Selection>({
		unavailable: () => Error("blocked"),
		scope: (work) => work(),
		contextKey: (v) => v.key,
		contextVersions: (v) => v.refs,
		merge: (current, incoming) => {
			const refs = [
				...(current?.refs ?? []),
				...incoming.refs.filter(
					(i) => !current?.refs.some((p) => p.identity === i.identity),
				),
			];
			return {
				value: { key: incoming.key, refs },
				addedCount: refs.length - (current?.refs.length ?? 0),
			};
		},
		proofKey: (p) => {
			assert.ok(issued.has(p), "forged proof");
			return p.key;
		},
		proofVersions: (p) => p.refs,
		admit: async (groups, proofs, _sequence, current) => {
			if (onAdmission) await onAdmission();
			assert.ok(allowed);
			for (const s of [...groups, ...proofs])
				for (const ref of s.refs) assert.equal(ref.version, version);
			current();
			audits++;
		},
	});
	const item = (id = "doc", project = "project-a"): Selection => ({
		key: project,
		refs: [{ identity: `tenant:${project}:${id}`, version }],
	});
	return {
		guard,
		item,
		issue: () => {
			const p = item();
			issued.add(p);
			return p;
		},
		change: () => {
			version = "v2";
		},
		revoke: () => {
			allowed = false;
		},
		audits: () => audits,
		onAdmission: (f: () => Promise<void>) => {
			onAdmission = f;
		},
	};
}
test("use admission rechecks current source on every request and remembers old transcript versions", async () => {
	const f = fixture();
	await f.guard.run(async () => {
		f.guard.bind(true);
		f.guard.registerContext(f.item());
		await f.guard.assertCurrent();
		assert.equal(f.audits(), 1);
		f.change();
		await assert.rejects(() => f.guard.assertCurrent(), /blocked/);
		assert.throws(() => f.guard.registerContext(f.item()), /blocked/);
	});
});
test("exact proof is nonserializable authority; revocation and unsupported consumers block", async () => {
	const f = fixture();
	await f.guard.run(async () => {
		f.guard.bind(true);
		const proof = f.issue();
		assert.throws(
			() => f.guard.registerProof(structuredClone(proof)),
			/forged/,
		);
		f.guard.registerProof(proof);
		await f.guard.assertCurrent();
		f.revoke();
		await assert.rejects(() => f.guard.assertCurrent(), /blocked/);
	});
	const u = fixture();
	await u.guard.run(async () => {
		u.guard.bind(false);
		assert.throws(() => u.guard.registerContext(u.item()), /blocked/);
	});
});
test("closed and detached scopes cannot admit or introduce new source bodies", async () => {
	const f = fixture();
	let late: () => Promise<void> = async () => {};
	await f.guard.run(async () => {
		f.guard.bind(true);
		late = () => f.guard.assertCurrent();
	});
	// Call outside a scope is independently forbidden.
	await assert.rejects(late, /blocked/);
	let detached!: Promise<void>, resume!: () => void;
	const gate = new Promise<void>((r) => {
		resume = r;
	});
	await f.guard.run(async () => {
		f.guard.bind(true);
		detached = (async () => {
			await gate;
			f.guard.registerContext(f.item());
		})();
	});
	resume();
	await assert.rejects(detached, /blocked/);
});
test("concurrent mutation during admission fails before an audit is accepted", async () => {
	const f = fixture();
	await f.guard.run(async () => {
		f.guard.bind(true);
		f.guard.registerContext(f.item());
		f.onAdmission(async () => {
			f.guard.registerContext(f.item("new-doc"));
		});
		await assert.rejects(() => f.guard.assertCurrent(), /blocked/);
		assert.equal(f.audits(), 0);
	});
});
test("namespace-qualified identities stay independent and duplicates do not consume the budget", async () => {
	const f = fixture();
	await f.guard.run(async () => {
		f.guard.bind(true);
		for (let i = 0; i < 300; i++) f.guard.registerContext(f.item());
		f.guard.registerContext(f.item("doc", "project-b"));
		await f.guard.assertCurrent();
		assert.equal(f.guard.snapshot().groups.length, 2);
	});
});
