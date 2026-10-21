import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import postgres from "postgres";
import { PROTOCOL } from "../../packages/memory/src/contracts";
import type {
	KnowledgePack,
	KnowledgeSourceRef,
} from "../../packages/memory/src/knowledge-contracts";
import {
	createDevelopmentProject,
	initializeDevelopmentProject,
	developmentDocumentVersion,
} from "./knowledge-project";
import { runRecordLoop } from "./record-loop";

/** Standalone Node acceptance. Requires a caller-created disposable PostgreSQL database. */
async function main() {
	const url = process.env.MEMORY_DEMO_DATABASE_URL;
	assert.ok(url);
	assert.match(new URL(url).pathname, /^\/zhiyu_test_[a-f0-9]{32}$/);
	const sql = postgres(url, { max: 10, onnotice: () => {} }),
		checks: string[] = [],
		deliveries: KnowledgePack[] = [];
	let providerFails = false;
	const provider = createServer(async (req, res) => {
		let data = "";
		for await (const chunk of req) data += chunk.toString();
		deliveries.push(JSON.parse(data));
		if (providerFails) res.statusCode = 500;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ acknowledged: true }));
	});
	const ready = once(provider, "listening");
	provider.listen(0, "127.0.0.1");
	await ready;
	const address = provider.address();
	assert.ok(address && typeof address !== "string");
	let clock = new Date("2026-10-21T05:00:00Z");
	const now = () => new Date(clock),
		tenant = "development-org",
		project = "pipeline-alpha",
		principal = "same-person";
	const n = { tenantId: tenant, projectId: project },
		other = { tenantId: tenant, projectId: "pipeline-beta" };
	const content =
		"Build 🧭 timed out. 核对 job 状态后才可重试。\r\nA changed commit requires a fresh observation.";
	const all = [
		"propose",
		"review",
		"revise",
		"recall",
		"read",
		"receipt",
		"use",
	];
	const domain = createDevelopmentProject(sql, {
		now,
		deliver: async (pack) => {
			assert.equal(Object.isFrozen(pack), true);
			const response = await fetch(`http://127.0.0.1:${address.port}/model`, {
				method: "POST",
				body: JSON.stringify(pack),
			});
			assert.equal(response.status, 200);
			return response.json();
		},
	});
	const command = (
		kind: string,
		payload: unknown,
		commandId: string = randomUUID(),
	) => ({ protocolVersion: PROTOCOL, kind, commandId, payload });
	const reject = (code: string) => (e: unknown) =>
		Boolean(e && typeof e === "object" && "code" in e && e.code === code);
	async function member(ns: typeof n, id: string, allowed = all) {
		await sql`INSERT INTO demo_dev_members_g4 VALUES(${ns.tenantId},${ns.projectId},${id},${sql.json(allowed)},${sql.json([])})`;
		await sql`INSERT INTO demo_dev_source_grants_g4 VALUES(${ns.tenantId},${ns.projectId},${id},'ci-guide',true,false)`;
	}
	const source = (ns = n, version = "doc-v1"): KnowledgeSourceRef => ({
		namespace: ns,
		sourceId: "demo.document",
		id: "ci-guide",
		version: developmentDocumentVersion({
			namespace: ns,
			id: "ci-guide",
			version,
			content,
			asOf: "2026-10-21T05:00:00.000Z",
		}),
		range: {
			start: 0,
			end: Array.from(content).length,
			unit: "unicode_code_points",
		},
		quote: content,
	});
	const proposal = (ns = n, version = "doc-v1") => ({
		recordType: "team_rule",
		scope: "pipeline",
		subject: "Retry a CI job",
		content: "Check the job status before retrying.",
		conditions: "Same pipeline and commit only.",
		counterexample:
			"Changed commit or pending execution requires new evidence.",
		tags: ["team-rule"],
		sources: [source(ns, version)],
	});
	async function document(ns: typeof n) {
		await sql`INSERT INTO demo_dev_documents_g4 VALUES(${ns.tenantId},${ns.projectId},'ci-guide','doc-v1',${content},${now()},null)`;
	}
	async function review(
		client: Awaited<ReturnType<typeof domain.forSession>>,
		r: { id: string; version: string },
	) {
		return client.execute(
			command("interpretation.review", {
				id: r.id,
				expectedVersion: r.version,
				decision: "accept",
				reason: "Checked exact original, applicability and counterexample.",
				evidenceConfirmed: true,
			}),
		);
	}
	const recall = { scope: "pipeline", query: "retry", maxBytes: 8192 };
	const selected = (p: KnowledgePack) => [
		...p.constraints,
		...p.interpretations,
	];
	const count = async (table: string) =>
		Number((await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
	try {
		await initializeDevelopmentProject(sql);
		await member(n, principal);
		await member(other, principal);
		await member(n, "reader", ["read", "recall", "use", "receipt"]);
		await document(n);
		await document(other);
		const a = await domain.forSession(
			domain.issueAuthenticatedSession({
				namespace: n,
				principalId: principal,
			}),
		);
		const b = await domain.forSession(
			domain.issueAuthenticatedSession({
				namespace: other,
				principalId: principal,
			}),
		);
		const reader = await domain.forSession(
			domain.issueAuthenticatedSession({ namespace: n, principalId: "reader" }),
		);
		const raw = await runRecordLoop(a.records, "same-observation"),
			otherRaw = await runRecordLoop(b.records, "same-observation");
		assert.equal(raw.retry.receipt.id, raw.saved.receipt.id);
		assert.notEqual(raw.saved.observation.id, otherRaw.saved.observation.id);
		await assert.rejects(
			() => b.records.read({ purpose: "current", ref: raw.saved.ref.record }),
			reject("namespace_mismatch"),
		);
		checks.push(
			"same_project_session_composes_R_K_U_and_raw_observation_retries_remain_project_isolated",
		);
		await assert.rejects(
			() => domain.forSession({ namespace: n, principalId: principal }),
			reject("untrusted_session"),
		);
		for (const field of [
			{ verified: true },
			{ owner: principal },
			{ namespace: other },
			{ reviewSatisfied: true },
		])
			await assert.rejects(
				() =>
					a.execute(
						command("interpretation.propose", { ...proposal(), ...field }),
					),
				reject("invalid_request"),
			);
		await assert.rejects(
			() =>
				a.execute(
					command("interpretation.propose", {
						...proposal(),
						tags: ["build-log"],
					}),
				),
			reject("policy_rejected"),
		);
		await assert.rejects(
			() =>
				a.execute(
					command("interpretation.propose", {
						...proposal(),
						tags: ["unknown"],
					}),
				),
			reject("policy_rejected"),
		);
		const bad = source();
		bad.quote = "fabricated";
		await assert.rejects(
			() =>
				a.execute(
					command("interpretation.propose", { ...proposal(), sources: [bad] }),
				),
			reject("evidence_mismatch"),
		);
		const unknown = source();
		unknown.sourceId = "unregistered";
		await assert.rejects(
			() =>
				a.execute(
					command("interpretation.propose", {
						...proposal(),
						sources: [unknown],
					}),
				),
			reject("unsupported_source"),
		);
		checks.push(
			"untrusted_sessions_privilege_fields_unknown_sources_operational_logs_and_forged_quotes_rejected",
		);
		const submit = command(
			"interpretation.propose",
			proposal(),
			"same-command",
		);
		const attempts = await Promise.all([
				a.execute(submit),
				a.execute(submit),
				a.execute(submit),
			]),
			candidate = attempts[0].outcome;
		assert.equal(new Set(attempts.map((x) => x.receipt.id)).size, 1);
		assert.equal(await count("general_memory_knowledge_g4"), 1);
		assert.equal(candidate.status, "candidate");
		assert.equal(candidate.reviewBy, "2027-01-19T05:00:00.000Z");
		assert.equal(selected(await a.recall(recall)).length, 0);
		await assert.rejects(
			async () => a.dispatch(await a.recall(recall), "demo.local-model"),
			reject("empty_context"),
		);
		await assert.rejects(
			() =>
				reader.execute(
					command("interpretation.review", {
						id: candidate.id,
						expectedVersion: candidate.version,
						decision: "accept",
						reason: "not authorized",
						evidenceConfirmed: true,
					}),
				),
			reject("access_denied"),
		);
		await assert.rejects(
			() =>
				a.execute({
					...submit,
					payload: { ...proposal(), content: "changed" },
				}),
			reject("idempotency_conflict"),
		);
		const duplicate = await a.execute(
			command("interpretation.propose", proposal()),
		);
		assert.equal(duplicate.outcome.id, candidate.id);
		assert.equal(duplicate.outcome.reviewBy, candidate.reviewBy);
		checks.push(
			"concurrent_command_replay_semantic_dedup_and_90_day_policy_do_not_activate_or_renew_candidates",
		);
		const evidence = await a.evidence({ ref: source() });
		assert.equal(evidence.content, content);
		assert.ok(!evidence.content.includes("�"));
		const verified = (await review(a, candidate)).outcome;
		await assert.rejects(
			() =>
				a.execute(
					command("interpretation.review", {
						id: candidate.id,
						expectedVersion: candidate.version,
						decision: "accept",
						reason: "stale",
						evidenceConfirmed: true,
					}),
				),
			reject("version_conflict"),
		);
		const pack = await a.recall(recall);
		assert.equal(pack.historicalEvidence[0].content, content);
		assert.equal(pack.historicalEvidence[0].useSemantics, "raw_observation");
		assert.throws(() => {
			pack.interpretations[0].content = "forged model context";
		});
		assert.equal(selected(pack).length, 1);
		assert.equal(selected(pack)[0].ref.version, verified.version);
		assert.ok(pack.receiptId);
		assert.equal(pack.budget.unit, "utf8_bytes_upper_bound");
		const delivered = await a.dispatch(pack, "demo.local-model");
		assert.equal(
			(
				(await a.read({
					purpose: "use_receipt",
					receiptId: delivered.admissionId,
				})) as any
			).state,
			"dispatched",
		);
		assert.equal(
			(
				await b.read({
					purpose: "use_receipt",
					receiptId: delivered.admissionId,
				})
			).status,
			"not_found",
		);
		assert.equal(deliveries.length, 1);
		await assert.rejects(
			() => a.dispatch(structuredClone(pack), "demo.local-model"),
			reject("untrusted_context"),
		);
		await assert.rejects(
			() => b.dispatch(pack, "demo.local-model"),
			reject("untrusted_context"),
		);
		await assert.rejects(
			() => a.dispatch(pack, "unknown-provider"),
			reject("unsupported_consumer"),
		);
		checks.push(
			"exact_unicode_evidence_owner_review_finalized_pack_and_registered_local_http_dispatch",
		);
		const independent = (
			await b.execute(
				command("interpretation.propose", proposal(other), "same-command"),
			)
		).outcome;
		assert.notEqual(independent.id, candidate.id);
		assert.equal(
			(await b.read({ purpose: "current", id: candidate.id })).status,
			"not_found",
		);
		assert.notEqual(
			((await b.read({ purpose: "receipt", commandId: "same-command" })) as any)
				.receipt.id,
			attempts[0].receipt.id,
		);
		await assert.rejects(
			() =>
				b.execute(
					command("interpretation.review", {
						id: candidate.id,
						expectedVersion: verified.version,
						decision: "accept",
						reason: "cross project",
						evidenceConfirmed: true,
					}),
				),
			reject("not_found"),
		);
		await assert.rejects(
			() => a.execute(command("interpretation.propose", proposal(other))),
			reject("namespace_mismatch"),
		);
		await assert.rejects(
			() => b.evidence({ ref: source() }),
			reject("namespace_mismatch"),
		);
		checks.push(
			"same_principal_and_command_id_are_project_isolated_across_records_receipts_sources_review_and_use",
		);
		const revised = await a.execute(
			command("interpretation.revise", {
				id: verified.id,
				expectedVersion: verified.version,
				reason: "Make condition explicit.",
				content: "Verify current job and commit before retry.",
				conditions: "Same current job and commit.",
				counterexample: "New commit cannot reuse this conclusion.",
				sources: [source()],
			}),
		);
		assert.equal(revised.outcome.status, "candidate");
		assert.equal(revised.outcome.previousId, verified.id);
		assert.equal(revised.outcome.reviewBy, verified.reviewBy);
		const before = deliveries.length;
		await assert.rejects(() => a.dispatch(pack, "demo.local-model"));
		assert.equal(deliveries.length, before);
		const accepted = (await review(a, revised.outcome)).outcome;
		const fresh = await a.recall(recall);
		assert.equal(selected(fresh).length, 1);
		assert.equal(selected(fresh)[0].ref.id, accepted.id);
		await a.dispatch(fresh, "demo.local-model");
		checks.push(
			"revision_keeps_history_retires_old_context_and_requires_a_new_review_without_deadline_extension",
		);
		await sql`UPDATE demo_dev_documents_g4 SET content=${content + "\nChanged outside the quoted span."} WHERE tenant_id=${tenant} AND project_id=${project}`;
		const outsideCalls = deliveries.length;
		await assert.rejects(() => a.dispatch(fresh, "demo.local-model"));
		assert.equal(deliveries.length, outsideCalls);
		await sql`UPDATE demo_dev_documents_g4 SET content=${content} WHERE tenant_id=${tenant} AND project_id=${project}`;
		await sql`UPDATE demo_dev_documents_g4 SET version='doc-v2' WHERE tenant_id=${tenant} AND project_id=${project}`;
		const priorCalls = deliveries.length;
		await assert.rejects(() => a.dispatch(fresh, "demo.local-model"));
		assert.equal(deliveries.length, priorCalls);
		assert.equal(selected(await a.recall(recall)).length, 0);
		await assert.rejects(() => review(a, accepted), reject("source_changed"));
		await sql`UPDATE demo_dev_documents_g4 SET version='doc-v1' WHERE tenant_id=${tenant} AND project_id=${project}`;
		await a.dispatch(await a.recall(recall), "demo.local-model");
		checks.push(
			"source_version_change_blocks_review_recall_and_old_pack_dispatch_without_notification_consumer",
		);
		const authorizedPack = await a.recall(recall);
		await sql`UPDATE demo_dev_source_grants_g4 SET denied=true WHERE tenant_id=${tenant} AND project_id=${project} AND principal_id=${principal}`;
		const beforeDenied = deliveries.length;
		await assert.rejects(() => a.dispatch(authorizedPack, "demo.local-model"));
		assert.equal(deliveries.length, beforeDenied);
		assert.equal(selected(await a.recall(recall)).length, 0);
		await assert.rejects(
			() => a.evidence({ ref: source() }),
			reject("source_denied"),
		);
		await assert.rejects(
			() => a.read({ purpose: "current", id: accepted.id }),
			reject("source_denied"),
		);
		await assert.rejects(
			() => a.read({ purpose: "receipt", commandId: "same-command" }),
			reject("source_denied"),
		);
		await assert.rejects(() => a.execute(submit), reject("source_denied"));
		await sql`UPDATE demo_dev_source_grants_g4 SET denied=false WHERE tenant_id=${tenant} AND project_id=${project} AND principal_id=${principal}`;
		await sql`UPDATE demo_dev_members_g4 SET denied=${sql.json(["use"])} WHERE tenant_id=${tenant} AND project_id=${project} AND principal_id=${principal}`;
		await assert.rejects(() => a.dispatch(authorizedPack, "demo.local-model"));
		assert.equal(deliveries.length, beforeDenied);
		await sql`UPDATE demo_dev_members_g4 SET denied=${sql.json([])} WHERE tenant_id=${tenant} AND project_id=${project} AND principal_id=${principal}`;
		checks.push(
			"source_and_member_denials_override_allow_and_block_exact_read_recall_and_dispatch",
		);
		clock = new Date("2027-01-19T05:00:00Z");
		await assert.rejects(() => a.dispatch(authorizedPack, "demo.local-model"));
		assert.equal(selected(await a.recall(recall)).length, 0);
		await assert.rejects(() => review(a, accepted), reject("expired"));
		const retry = await a.execute(submit);
		assert.equal(retry.outcome.id, candidate.id);
		assert.equal(retry.outcome.reviewBy, candidate.reviewBy);
		await assert.rejects(
			() =>
				a.execute(
					command("interpretation.revise", {
						id: accepted.id,
						expectedVersion: accepted.version,
						reason: "cannot renew",
						content: "new text",
						conditions: "same",
						counterexample: "same",
						sources: [source()],
					}),
				),
			reject("new_evidence_required"),
		);
		await sql`UPDATE demo_dev_documents_g4 SET version='doc-v2' WHERE tenant_id=${tenant} AND project_id=${project}`;
		const renewed = (
			await a.execute(command("interpretation.propose", proposal(n, "doc-v2")))
		).outcome;
		await review(a, renewed);
		await a.dispatch(await a.recall(recall), "demo.local-model");
		checks.push(
			"deadline_blocks_review_recall_dispatch_and_retry_renewal_new_evidence_needs_explicit_proposal_and_review",
		);
		const stable = await a.recall(recall),
			callsBeforeFault = deliveries.length,
			auditsBeforeFault = await count("general_memory_knowledge_audits_g4");
		await sql.unsafe(
			"CREATE FUNCTION demo_g4_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='use_admitted' THEN RAISE EXCEPTION 'synthetic deferred G4 audit failure'; END IF; RETURN NEW; END $$",
		);
		await sql.unsafe(
			"CREATE CONSTRAINT TRIGGER demo_g4_fail_audit AFTER INSERT ON general_memory_knowledge_audits_g4 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION demo_g4_fail_audit()",
		);
		try {
			await assert.rejects(() => a.dispatch(stable, "demo.local-model"));
			assert.equal(deliveries.length, callsBeforeFault);
			assert.equal(
				await count("general_memory_knowledge_audits_g4"),
				auditsBeforeFault,
			);
		} finally {
			await sql.unsafe(
				"DROP TRIGGER demo_g4_fail_audit ON general_memory_knowledge_audits_g4",
			);
			await sql.unsafe("DROP FUNCTION demo_g4_fail_audit()");
		}
		await a.dispatch(stable, "demo.local-model");
		providerFails = true;
		const beforeUnknown = deliveries.length;
		try {
			let unknownAdmissionId = "";
			await assert.rejects(
				() => a.dispatch(stable, "demo.local-model"),
				(error: unknown) => {
					if (!reject("dispatch_outcome_unknown")(error)) return false;
					unknownAdmissionId = (error as { admissionId: string }).admissionId;
					assert.ok(unknownAdmissionId);
					return true;
				},
			);
			assert.equal(
				(
					(await a.read({
						purpose: "use_receipt",
						receiptId: unknownAdmissionId,
					})) as any
				).state,
				"outcome_unknown",
			);
			assert.equal(deliveries.length, beforeUnknown + 1);
			assert.ok(
				Number(
					(
						await sql`SELECT count(*)::int AS n FROM general_memory_knowledge_audits_g4 WHERE kind='use_outcome_unknown'`
					)[0].n,
				) > 0,
			);
		} finally {
			providerFails = false;
		}
		checks.push(
			"registered_consumer_failure_records_unknown_and_never_automatically_retries_delivery",
		);
		checks.push(
			"deferred_use_audit_commit_failure_prevents_any_provider_call_and_safely_recovers",
		);
		await sql.unsafe(
			"CREATE FUNCTION demo_g4_fail_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic command receipt failure'; END $$",
		);
		await sql.unsafe(
			"CREATE CONSTRAINT TRIGGER demo_g4_fail_command AFTER INSERT ON general_memory_knowledge_commands_g4 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION demo_g4_fail_command()",
		);
		const failedCommand = command("interpretation.propose", {
				...proposal(n, "doc-v2"),
				content: "A separately reviewed command.",
			}),
			recordsBefore = await count("general_memory_knowledge_g4"),
			historyBefore = await count("general_memory_knowledge_history_g4");
		try {
			await assert.rejects(() => a.execute(failedCommand));
			assert.equal(await count("general_memory_knowledge_g4"), recordsBefore);
			assert.equal(
				await count("general_memory_knowledge_history_g4"),
				historyBefore,
			);
		} finally {
			await sql.unsafe(
				"DROP TRIGGER demo_g4_fail_command ON general_memory_knowledge_commands_g4",
			);
			await sql.unsafe("DROP FUNCTION demo_g4_fail_command()");
		}
		await a.execute(failedCommand);
		assert.equal(await count("general_memory_knowledge_g4"), recordsBefore + 1);
		checks.push(
			"candidate_audit_history_and_receipt_rollback_atomically_on_commit_failure_then_same_command_recovers",
		);
		const foreignTenant = { tenantId: "another-org", projectId: project };
		await member(foreignTenant, principal);
		await document(foreignTenant);
		const foreign = await domain.forSession(
			domain.issueAuthenticatedSession({
				namespace: foreignTenant,
				principalId: principal,
			}),
		);
		assert.equal(
			(await foreign.read({ purpose: "current", id: accepted.id })).status,
			"not_found",
		);
		assert.equal(
			(await foreign.read({ purpose: "receipt", commandId: "same-command" }))
				.status,
			"not_found",
		);
		await assert.rejects(
			() => foreign.dispatch(stable, "demo.local-model"),
			reject("untrusted_context"),
		);
		const deadlineOverflow = {
			...proposal(n, "doc-v2"),
			reviewBy: "2027-07-31T05:00:00Z",
		};
		await assert.rejects(
			() => a.execute(command("interpretation.propose", deadlineOverflow)),
			reject("invalid_review_deadline"),
		);
		const sourceExpiry = now().toISOString();
		await sql`UPDATE demo_dev_documents_g4 SET expires_at=${sourceExpiry} WHERE tenant_id=${tenant} AND project_id=${project}`;
		const expiredRef = source(n, "doc-v2");
		expiredRef.version = developmentDocumentVersion({
			namespace: n,
			id: "ci-guide",
			version: "doc-v2",
			content,
			asOf: "2026-10-21T05:00:00.000Z",
			expiresAt: sourceExpiry,
		});
		await assert.rejects(
			() => a.evidence({ ref: expiredRef }),
			reject("source_expired"),
		);
		const expiredCalls = deliveries.length;
		await assert.rejects(() => a.dispatch(stable, "demo.local-model"));
		assert.equal(deliveries.length, expiredCalls);
		await sql`UPDATE demo_dev_documents_g4 SET expires_at=null WHERE tenant_id=${tenant} AND project_id=${project}`;
		const current = selected(await a.recall(recall))[0];
		const retired = await a.execute(
			command("interpretation.retire", {
				id: current.ref.id,
				expectedVersion: current.ref.version,
				reason: "Owner pauses this rule.",
			}),
		);
		await assert.rejects(() => review(a, retired.outcome));
		await assert.rejects(() => a.dispatch(stable, "demo.local-model"));
		await assert.rejects(
			() =>
				sql`UPDATE general_memory_knowledge_history_g4 SET version='overwrite'`,
		);
		checks.push(
			"cross_tenant_isolation_source_expiry_180_day_cap_explicit_retirement_and_immutable_history",
		);
		const tagged = await a.execute(
			command("interpretation.propose", {
				...proposal(n, "doc-v2"),
				tags: ["team-rule", "new-policy-input"],
			}),
		);
		assert.notEqual(tagged.outcome.id, renewed.id);
		await assert.rejects(
			() =>
				a.execute(
					command("interpretation.propose", {
						...proposal(n, "doc-v2"),
						reviewBy: "2027-02-01T05:00:00Z",
					}),
				),
			reject("existing_deadline_conflict"),
		);
		checks.push(
			"semantic_dedup_includes_policy_labels_and_rejects_retiming_an_existing_record",
		);
		await sql`UPDATE demo_dev_members_g4 SET allowed=${sql.json("review")} WHERE tenant_id=${other.tenantId} AND project_id=${other.projectId} AND principal_id=${principal}`;
		await assert.rejects(
			() => b.read({ purpose: "current", id: independent.id }),
			reject("access_denied"),
		);
		const tables = (
			await sql`SELECT tablename FROM pg_tables WHERE schemaname='public'`
		).map((r) => String(r.tablename));
		assert.ok(
			tables.every(
				(t) => t.startsWith("general_memory_") || t.startsWith("demo_dev_"),
			),
		);
		assert.ok(!tables.includes("workshops"));
		const result = {
			passed: true,
			checks,
			groups: checks.length,
			databaseScope: "fresh_independent_project_only",
			noApplicationTables: true,
			realProviderCalled: false,
			localHttpRequests: deliveries.length,
			policy: "demo-dev.memory.records@1.0.0",
			defaultReviewDays: 90,
			maxReviewDays: 180,
		};
		if (process.env.MEMORY_DEMO_RESULT)
			fs.writeFileSync(
				process.env.MEMORY_DEMO_RESULT,
				JSON.stringify(result, null, 2),
			);
		console.log(JSON.stringify(result));
	} finally {
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
		await sql.end();
	}
}
main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
