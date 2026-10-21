import assert from "node:assert/strict";
import fs from "node:fs";
import { fork, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createRemoteMemoryClient } from "../../packages/memory/src/http";
import { PROTOCOL } from "../../packages/memory/src/contracts";
import {
	initializeServiceIdentitySchema,
	createServiceIdentityProvider,
} from "../../packages/memory-postgres/src/service-identity";
import {
	initializeDevelopmentProject,
	developmentDocumentVersion,
} from "./knowledge-project";

async function main() {
	const url = process.env.MEMORY_DEMO_DATABASE_URL!;
	assert.match(new URL(url).pathname, /^\/zhiyu_test_[a-f0-9]{32}$/);
	const sql = postgres(url, { max: 12, onnotice: () => {} }),
		checks: string[] = [],
		children: ChildProcess[] = [];
	const deliveries: any[] = [];
	let providerFails = false;
	const provider = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c);
		deliveries.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		res.statusCode = providerFails ? 500 : 200;
		res.end();
	});
	provider.listen(0, "127.0.0.1");
	await once(provider, "listening");
	const address = provider.address();
	assert.ok(address && typeof address !== "string");
	const providerPort = address.port;
	const all = [
		"propose",
		"review",
		"revise",
		"recall",
		"read",
		"receipt",
		"use",
	];
	const n = { tenantId: "shared-org", projectId: "alpha" },
		beta = { ...n, projectId: "beta" },
		other = { tenantId: "another-org", projectId: "alpha" };
	const content = "检查运行状态 🧭 再重试。Fixed commit only.",
		asOf = new Date().toISOString();
	const recall = { scope: "pipeline", query: "retry", maxBytes: 16384 };
	const consumerId = "demo.local-model",
		purpose = "ci-review";
	const command = (
		kind: string,
		payload: unknown,
		commandId = randomUUID(),
	) => ({ protocolVersion: PROTOCOL, kind, commandId, payload });
	const is = (code: string) => (e: any) => e.code === code;
	async function start() {
		const child = fork("apps/service/main.ts", [], {
			execArgv: ["--import", "tsx"],
			env: {
				...process.env,
				MEMORY_SERVICE_DATABASE_URL: url,
				MEMORY_SERVICE_CONSUMER_URL: `http://127.0.0.1:${providerPort}/model`,
			},
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		});
		children.push(child);
		const ready = await Promise.race([
			once(child, "message"),
			once(child, "exit").then(() => {
				throw Error("service_exited_before_ready");
			}),
			new Promise<never>((_, reject) => {
				const timer = setTimeout(
					() => reject(Error("service_start_timeout")),
					20000,
				);
				timer.unref();
			}),
		]);
		assert.equal(ready[0].ready, true);
		return { child, origin: `http://127.0.0.1:${ready[0].port}/` };
	}
	async function stop(child: ChildProcess) {
		if (child.exitCode !== null) return;
		const done = once(child, "exit");
		child.send("stop");
		await done;
	}
	try {
		await initializeDevelopmentProject(sql);
		await initializeServiceIdentitySchema(sql);
		const auth = createServiceIdentityProvider(sql);
		async function provision(ns: typeof n, principalId = "reviewer") {
			await sql`INSERT INTO demo_dev_members_g4 VALUES(${ns.tenantId},${ns.projectId},${principalId},${sql.json(all)},'[]'::jsonb)`;
			await sql`INSERT INTO demo_dev_source_grants_g4 VALUES(${ns.tenantId},${ns.projectId},${principalId},'ci-guide',true,false)`;
			await sql`INSERT INTO demo_dev_documents_g4 VALUES(${ns.tenantId},${ns.projectId},'ci-guide','v1',${content},${asOf},null) ON CONFLICT DO NOTHING`;
			return auth.issue(
				{ namespace: ns, principalId },
				all,
				new Date(Date.now() + 3600000).toISOString(),
				"synthetic-admin",
			);
		}
		const a = await provision(n),
			b = await provision(beta),
			c = await provision(other),
			second = await auth.issue(
				{ namespace: n, principalId: "reviewer" },
				all,
				new Date(Date.now() + 3600000).toISOString(),
				"synthetic-admin",
			);
		const one = await start(),
			two = await start();
		assert.notEqual(one.child.pid, two.child.pid);
		const client = createRemoteMemoryClient(one.origin, a.token),
			peer = createRemoteMemoryClient(two.origin, a.token);
		const projectB = createRemoteMemoryClient(two.origin, b.token),
			tenantB = createRemoteMemoryClient(two.origin, c.token),
			samePersonNewKey = createRemoteMemoryClient(two.origin, second.token);
		assert.equal(
			(await client.request("/v1/capabilities")).namespace.projectId,
			"alpha",
		);
		assert.equal(
			(await fetch(new URL("/v1/capabilities", one.origin))).status,
			401,
		);
		assert.equal(
			(
				await fetch(new URL("/v1/capabilities", one.origin), {
					headers: { authorization: `Bearer ${"x".repeat(43)}` },
				})
			).status,
			401,
		);
		assert.equal(
			(
				await fetch(new URL("/v1/capabilities", one.origin), {
					headers: {
						authorization: `Bearer ${a.token}`,
						origin: "https://untrusted.example",
					},
				})
			).status,
			403,
		);
		checks.push(
			"separate_processes_authentication_and_no_ambient_browser_identity",
		);

		const rawCommand = command("observation.append", {
			source: { sourceId: "demo.build", externalId: "build-one" },
			observedAt: asOf,
			content,
		});
		const saved = await client.request("/v1/records/commands", rawCommand);
		const replay = await peer.request("/v1/records/commands", rawCommand);
		assert.equal(saved.receipt.id, replay.receipt.id);
		assert.equal(replay.replayed, true);
		const rawRead = await peer.request("/v1/records/query", {
			purpose: "current",
			ref: saved.ref.record,
		});
		assert.equal(rawRead.content, content);
		assert.ok(!rawRead.content.includes("�"));
		const otherSaved = await projectB.request(
			"/v1/records/commands",
			rawCommand,
		);
		assert.equal(otherSaved.ref.record.projectId, "beta");
		assert.notEqual(otherSaved.receipt.id, saved.receipt.id);
		await assert.rejects(
			projectB.request("/v1/records/query", {
				purpose: "current",
				ref: saved.ref.record,
			}),
			is("namespace_mismatch"),
		);
		const anotherSaved = await tenantB.request(
			"/v1/records/commands",
			rawCommand,
		);
		assert.equal(anotherSaved.ref.record.tenantId, other.tenantId);
		assert.notEqual(anotherSaved.receipt.id, saved.receipt.id);
		checks.push(
			"remote_observation_exact_read_and_cross_process_idempotence_unicode_roundtrip",
		);
		const sources = [
			{
				namespace: n,
				sourceId: "demo.document",
				id: "ci-guide",
				version: developmentDocumentVersion({
					namespace: n,
					id: "ci-guide",
					version: "v1",
					content,
					asOf,
				}),
				range: {
					start: 0,
					end: Array.from(content).length,
					unit: "unicode_code_points",
				},
				quote: content,
			},
		];
		const propose = command("interpretation.propose", {
			recordType: "team_rule",
			scope: "pipeline",
			subject: "Retry a job",
			content: "Check status before retry.",
			conditions: "Fixed commit only.",
			counterexample: "Changed commit needs new evidence.",
			tags: ["team-rule"],
			sources,
		});
		const proposed = await client.request("/v1/commands", propose);
		assert.equal(proposed.receipt.record.status, "candidate");
		assert.equal(
			(await peer.request("/v1/commands", propose)).receipt.id,
			proposed.receipt.id,
		);
		const accepted = await peer.request(
			"/v1/commands",
			command("interpretation.review", {
				id: proposed.receipt.record.id,
				expectedVersion: proposed.receipt.record.version,
				decision: "accept",
				reason: "Checked original and conditions.",
				evidenceConfirmed: true,
			}),
		);
		assert.equal(accepted.receipt.record.status, "verified");
		const prepare = () =>
			client.request("/v1/use/prepare", { recall, consumerId, purpose });
		const dispatch = (target: typeof peer, use: any) =>
			target.request("/v1/use/dispatch", {
				credential: use.credential,
				consumerId,
				purpose,
			});
		let prepared = await prepare();
		assert.equal(prepared.pack.interpretations.length, 1);
		await assert.rejects(
			peer.request("/v1/use/dispatch", {
				credential: prepared.use.credential,
				consumerId,
				purpose,
				pack: prepared.pack,
			}),
			is("invalid_request"),
		);
		await assert.rejects(
			peer.request("/v1/use/dispatch", {
				credential: prepared.use.credential,
				consumerId,
				purpose: "another-purpose",
			}),
			is("invalid_use_credential"),
		);
		await assert.rejects(
			peer.request("/v1/use/dispatch", {
				credential: prepared.use.credential,
				consumerId: "unregistered-consumer",
				purpose,
			}),
			is("invalid_use_credential"),
		);
		await assert.rejects(
			dispatch(samePersonNewKey, prepared.use),
			is("invalid_use_credential"),
		);
		await assert.rejects(
			dispatch(projectB, prepared.use),
			is("invalid_use_credential"),
		);
		await assert.rejects(
			dispatch(tenantB, prepared.use),
			is("invalid_use_credential"),
		);
		await assert.rejects(
			client.request("/v1/recall", { ...recall, namespace: beta }),
			is("invalid_request"),
		);
		assert.equal(
			(await projectB.request("/v1/recall", recall)).interpretations.length,
			0,
		);
		assert.equal(
			(await tenantB.request("/v1/recall", recall)).interpretations.length,
			0,
		);
		checks.push(
			"remote_candidate_review_recall_and_shared_tenant_project_principal_consumer_purpose_bindings",
		);
		const count = deliveries.length;
		const race = await Promise.allSettled([
			dispatch(client, prepared.use),
			dispatch(peer, prepared.use),
		]);
		assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
		assert.equal(deliveries.length, count + 1);
		assert.ok(
			["use_already_consumed", "knowledge_dispatch_blocked"].includes(
				(race.find((r) => r.status === "rejected") as PromiseRejectedResult)
					.reason.code,
			),
		);
		const admissionId = (
			race.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>
		).value.admissionId;
		const receipt = await peer.request("/v1/read", {
			purpose: "use_receipt",
			receiptId: admissionId,
		});
		assert.equal(receipt.status, "ok");
		const status = await peer.request("/v1/use/status", {
			credential: prepared.use.credential,
			consumerId,
			purpose,
		});
		assert.equal(status.state, "dispatched");
		assert.equal(status.admissionId, admissionId);
		const forbiddenReceipt = await projectB.request("/v1/read", {
			purpose: "use_receipt",
			receiptId: admissionId,
		});
		assert.equal(forbiddenReceipt.status, "not_found");
		checks.push(
			"atomic_single_consumption_across_processes_and_scoped_use_receipts",
		);

		prepared = await prepare();
		await stop(one.child);
		const restarted = await start();
		const restartClient = createRemoteMemoryClient(restarted.origin, a.token);
		assert.equal(
			(await dispatch(restartClient, prepared.use)).status,
			"dispatched",
		);
		assert.equal(
			(await restartClient.request("/v1/records/commands", rawCommand)).receipt
				.id,
			saved.receipt.id,
		);
		// Continue on the survivor. Original process-local seals no longer exist.
		const preparePeer = () =>
			peer.request("/v1/use/prepare", { recall, consumerId, purpose });
		checks.push(
			"durable_remote_credential_and_command_receipt_survive_service_restart",
		);

		let before = deliveries.length;
		prepared = await preparePeer();
		await sql`UPDATE demo_dev_documents_g4 SET content=content || ' outside-quote change' WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId}`;
		await assert.rejects(dispatch(restartClient, prepared.use));
		assert.equal(deliveries.length, before);
		await sql`UPDATE demo_dev_documents_g4 SET content=${content} WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId}`;
		checks.push(
			"source_change_outside_selected_quote_blocks_final_remote_dispatch",
		);
		prepared = await preparePeer();
		await sql`UPDATE demo_dev_source_grants_g4 SET denied=true WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId}`;
		await assert.rejects(dispatch(restartClient, prepared.use));
		assert.equal(deliveries.length, before);
		await sql`UPDATE demo_dev_source_grants_g4 SET denied=false WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId}`;
		prepared = await preparePeer();
		await sql`UPDATE demo_dev_members_g4 SET denied='["use"]'::jsonb WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId}`;
		await assert.rejects(
			dispatch(restartClient, prepared.use),
			is("access_denied"),
		);
		assert.equal(deliveries.length, before);
		await sql`UPDATE demo_dev_members_g4 SET denied='[]'::jsonb WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId}`;
		checks.push("source_and_member_denied_override_allowed_at_final_egress");

		prepared = await preparePeer();
		await sql`UPDATE general_memory_remote_use_g5 SET ticket=jsonb_set(ticket,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE ticket->>'packHash'=${prepared.use.packHash}`;
		await assert.rejects(
			dispatch(restartClient, prepared.use),
			is("use_credential_expired"),
		);
		assert.equal(deliveries.length, before);
		prepared = await preparePeer();
		await sql`UPDATE demo_dev_documents_g4 SET expires_at=now()-interval '1 second' WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId}`;
		await assert.rejects(dispatch(restartClient, prepared.use));
		assert.equal(deliveries.length, before);
		await sql`UPDATE demo_dev_documents_g4 SET expires_at=null WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId}`;
		prepared = await preparePeer();
		await auth.replacePermissions(a.id, all, ["use"], "synthetic-admin");
		await assert.rejects(
			dispatch(restartClient, prepared.use),
			is("credential_denied"),
		);
		assert.equal(deliveries.length, before);
		await auth.replacePermissions(a.id, all, [], "synthetic-admin");
		await assert.rejects(
			dispatch(restartClient, prepared.use),
			is("invalid_use_credential"),
		);
		assert.equal(deliveries.length, before);
		checks.push(
			"short_ttl_source_expiry_and_identity_epoch_prevent_old_credential_use",
		);

		prepared = await preparePeer();
		providerFails = true;
		let unknownId = "";
		await assert.rejects(dispatch(restartClient, prepared.use), (e: any) => {
			unknownId = e.admissionId;
			return e.code === "dispatch_outcome_unknown" && !!unknownId;
		});
		assert.equal(deliveries.length, before + 1);
		providerFails = false;
		await assert.rejects(
			dispatch(peer, prepared.use),
			is("use_already_consumed"),
		);
		assert.equal(deliveries.length, before + 1);
		assert.equal(
			(
				await peer.request("/v1/read", {
					purpose: "use_receipt",
					receiptId: unknownId,
				})
			).status,
			"ok",
		);
		assert.equal(
			(
				await peer.request("/v1/use/status", {
					credential: prepared.use.credential,
					consumerId,
					purpose,
				})
			).state,
			"outcome_unknown",
		);
		checks.push(
			"unknown_delivery_outcome_is_queryable_and_never_automatically_retried",
		);

		prepared = await preparePeer();
		before = deliveries.length;
		// Deferred failure tests commit, rather than merely a successful INSERT callback.
		await sql.unsafe(
			"CREATE FUNCTION service_g5_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='use_admitted' THEN RAISE EXCEPTION 'synthetic commit failure'; END IF; RETURN NEW; END $$",
		);
		await sql.unsafe(
			"CREATE CONSTRAINT TRIGGER service_g5_audit_fail AFTER INSERT ON general_memory_knowledge_audits_g4 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION service_g5_audit_fail()",
		);
		await assert.rejects(dispatch(restartClient, prepared.use));
		assert.equal(deliveries.length, before);
		const [unconsumed] =
			await sql`SELECT ticket FROM general_memory_remote_use_g5 WHERE ticket->>'packHash'=${prepared.use.packHash} AND NOT(ticket ? 'admissionId') ORDER BY token_hash LIMIT 1`;
		assert.ok(unconsumed);
		await sql`DROP TRIGGER service_g5_audit_fail ON general_memory_knowledge_audits_g4`;
		assert.equal((await dispatch(peer, prepared.use)).status, "dispatched");
		checks.push(
			"deferred_admission_commit_failure_rolls_back_credential_consumption_and_sends_nothing",
		);

		// Each credential can expire while a request waits for the source row.
		for (const deadlineKind of ["use", "identity"]) {
			prepared = await preparePeer();
			before = deliveries.length;
			if (deadlineKind === "use")
				await sql`UPDATE general_memory_remote_use_g5 SET ticket=jsonb_set(ticket,'{expiresAt}',to_jsonb(${new Date(Date.now() + 1000).toISOString()}::text)) WHERE ticket->>'packHash'=${prepared.use.packHash} AND NOT(ticket ? 'admissionId')`;
			else
				await sql`UPDATE general_memory_credentials_g5 SET expires_at=${new Date(Date.now() + 1000).toISOString()} WHERE id=${a.id}`;
			let unlock!: () => void, locked!: () => void;
			const readyLock = new Promise<void>((resolve) => {
					locked = resolve;
				}),
				releaseLock = new Promise<void>((resolve) => {
					unlock = resolve;
				});
			const blocker = sql.begin(async (tx) => {
				await tx`SELECT id FROM demo_dev_documents_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND id='ci-guide' FOR UPDATE`;
				locked();
				await releaseLock;
			});
			await readyLock;
			const pendingDispatch = dispatch(restartClient, prepared.use).then(
				(value) => ({ value, error: null as any }),
				(error) => ({ value: null, error }),
			);
			try {
				let observedWait = false;
				for (let attempt = 0; attempt < 80; attempt++) {
					const rows =
						await sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT version,content,as_of,expires_at FROM demo_dev_documents_g4%'`;
					if (rows.length) {
						observedWait = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.equal(observedWait, true);
				await new Promise((resolve) => setTimeout(resolve, 1100));
			} finally {
				unlock();
				await blocker;
			}
			const waited = await pendingDispatch;
			assert.equal(waited.error?.code, "knowledge_dispatch_blocked");
			assert.equal(deliveries.length, before);
			if (deadlineKind === "identity")
				await sql`UPDATE general_memory_credentials_g5 SET expires_at=${a.expiresAt} WHERE id=${a.id}`;
		}
		checks.push(
			"post_source_lock_clock_recheck_blocks_use_and_identity_credentials_expired_while_waiting",
		);

		prepared = await preparePeer();
		before = deliveries.length;
		await auth.revoke(a.id, "synthetic-admin");
		await assert.rejects(
			dispatch(restartClient, prepared.use),
			is("credential_invalid"),
		);
		assert.equal(deliveries.length, before);
		await assert.rejects(
			peer.request("/v1/commands", propose),
			is("credential_invalid"),
		);
		checks.push(
			"administrative_revoke_disables_old_key_reads_commands_replays_and_egress",
		);
		const revised = await samePersonNewKey.request(
			"/v1/commands",
			command("interpretation.revise", {
				id: accepted.receipt.record.id,
				expectedVersion: accepted.receipt.record.version,
				reason: "Clarify applicability.",
				content: "Check exact job status before retry.",
				conditions: "Same job and commit.",
				counterexample: "Changed commit needs new evidence.",
				sources,
			}),
		);
		assert.equal(revised.receipt.record.status, "candidate");
		assert.equal(
			(await samePersonNewKey.request("/v1/recall", recall)).interpretations
				.length,
			0,
		);
		await samePersonNewKey.request(
			"/v1/commands",
			command("interpretation.review", {
				id: revised.receipt.record.id,
				expectedVersion: revised.receipt.record.version,
				decision: "accept",
				reason: "Reviewed revision.",
				evidenceConfirmed: true,
			}),
		);
		assert.equal(
			(await samePersonNewKey.request("/v1/recall", recall)).interpretations
				.length,
			1,
		);
		checks.push(
			"remote_revision_requires_new_review_and_recovers_without_changing_legacy_project",
		);
		const privateInput = path.join(
			path.dirname(process.env.MEMORY_DEMO_RESULT!),
			`operator-${randomUUID()}.json`,
		);
		const privateOutput = `${privateInput}.credential`;
		try {
			fs.writeFileSync(
				privateInput,
				JSON.stringify({
					identity: { namespace: n, principalId: "reviewer" },
					allowed: ["read", "receipt"],
					expiresAt: new Date(Date.now() + 60000).toISOString(),
					actor: "synthetic-cli-admin",
					outputFile: privateOutput,
				}),
			);
			const result = await promisify(execFile)(
				process.execPath,
				[
					"--import",
					"tsx",
					"apps/service/admin.ts",
					"issue",
					privateInput,
				],
				{
					env: { ...process.env, MEMORY_SERVICE_DATABASE_URL: url },
					windowsHide: true,
				},
			);
			const issued = JSON.parse(fs.readFileSync(privateOutput, "utf8"));
			assert.ok(!result.stdout.includes(issued.token));
			const issuedClient = createRemoteMemoryClient(two.origin, issued.token);
			assert.equal(
				(await issuedClient.request("/v1/capabilities")).namespace.projectId,
				"alpha",
			);
			await assert.rejects(
				issuedClient.request("/v1/recall", recall),
				is("credential_denied"),
			);
			await sql`UPDATE general_memory_credentials_g5 SET expires_at=now()-interval '1 second' WHERE id=${issued.id}`;
			await assert.rejects(
				issuedClient.request("/v1/capabilities"),
				is("credential_invalid"),
			);
			fs.writeFileSync(
				privateInput,
				JSON.stringify({ id: issued.id, actor: "synthetic-cli-admin" }),
			);
			await promisify(execFile)(
				process.execPath,
				[
					"--import",
					"tsx",
					"apps/service/admin.ts",
					"revoke",
					privateInput,
				],
				{
					env: { ...process.env, MEMORY_SERVICE_DATABASE_URL: url },
					windowsHide: true,
				},
			);
			const [state] =
				await sql`SELECT revoked FROM general_memory_credentials_g5 WHERE id=${issued.id}`;
			assert.equal(state.revoked, true);
			await assert.rejects(
				sql`DELETE FROM general_memory_identity_events_g5 WHERE credential_id=${issued.id}`,
			);
		} finally {
			for (const file of [privateInput, privateOutput])
				if (fs.existsSync(file)) fs.unlinkSync(file);
		}
		checks.push(
			"operator_cli_secret_file_least_privilege_key_expiry_revoke_and_immutable_identity_audit",
		);
		fs.writeFileSync(
			process.env.MEMORY_DEMO_RESULT!,
			JSON.stringify(
				{
					passed: true,
					checks,
					serviceProcessesStarted: children.length,
					controlledDeliveries: deliveries.length,
					dailyDatabaseUsed: false,
					applicationMigrationsRun: false,
				},
				null,
				2,
			),
		);
		console.log(
			JSON.stringify({
				passed: true,
				groups: checks.length,
				serviceProcessesStarted: children.length,
				controlledDeliveries: deliveries.length,
			}),
		);
	} finally {
		await Promise.all(children.map(stop));
		provider.close();
		provider.closeAllConnections();
		await sql.end({ timeout: 5 });
	}
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
