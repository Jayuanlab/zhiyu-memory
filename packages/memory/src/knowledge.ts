import { randomUUID, randomBytes } from "node:crypto";
import { PROTOCOL, MemoryError, type Namespace } from "./contracts";
import { digest } from "./core";
import { object, keys, text, date, namespace, fail } from "./validation";
import type { Identity, SourceDescriptor } from "./ports";
import { createSourceRegistry } from "./sources";
import { evaluateBusinessPolicy, type BusinessPolicy } from "./policy";
import {
	runGovernedCommand,
	reviewTransitionIssue,
	revisionTransitionIssue,
	assessDependencies,
} from "./governance";
import { budgetContextPack, selectRecallCandidates } from "./context";
import { createUseGuard } from "./use";
import { parseRetrieval, retrieveKnowledge, type SemanticSearch } from "./semantic-search";
import type {
	KnowledgeRecord,
	KnowledgeSourceRef,
	KnowledgeReceipt,
	KnowledgeStore,
	KnowledgeTransaction,
	KnowledgePack,
	KnowledgeEntry,
	KnowledgeOperation,
} from "./knowledge-contracts";

export type KnowledgeInstallation = {
	store: KnowledgeStore;
	sources: readonly SourceDescriptor[];
	policy: BusinessPolicy;
	consumers: Readonly<
		Record<string, { send(pack: Readonly<KnowledgePack>): Promise<unknown> }>
	>;
	now?: () => Date;
	/** Trusted host only: stable credential id + authorization epoch; never client supplied. */
	remoteBinding?: (identity: Identity) => string;
	/** Trusted opt-in: qualified knowledge text and queries are sent to this provider. */
	semanticSearch?: SemanticSearch;
};
const same = (a: Namespace, b: Namespace) =>
	a.tenantId === b.tenantId && a.projectId === b.projectId;
function freeze<T>(v: T): T {
	if (v && typeof v === "object") {
		for (const c of Object.values(v)) freeze(c);
		Object.freeze(v);
	}
	return v;
}
const version = (r: Omit<KnowledgeRecord, "version"> | KnowledgeRecord) => {
	const { version: _version, ...data } = r as KnowledgeRecord;
	return `gkrv1:${digest(data)}`;
};
function parseSources(
	value: unknown,
	n: Namespace,
	registered: (id: string) => boolean,
): KnowledgeSourceRef[] {
	if (!Array.isArray(value) || !value.length || value.length > 8)
		fail("invalid_request");
	return value.map((v) => {
		const s = object(v);
		keys(s, ["namespace", "sourceId", "id", "version", "range", "quote"]);
		const ns = namespace(s.namespace);
		if (!same(ns, n)) fail("namespace_mismatch", 403);
		const sourceId = text(s.sourceId, 200);
		if (!registered(sourceId)) fail("unsupported_source", 422);
		const range = object(s.range);
		keys(range, ["start", "end", "unit"]);
		if (
			range.unit !== "unicode_code_points" ||
			!Number.isSafeInteger(range.start) ||
			!Number.isSafeInteger(range.end) ||
			Number(range.start) < 0 ||
			Number(range.end) <= Number(range.start) ||
			Number(range.end) - Number(range.start) > 8192
		)
			fail("invalid_range");
		return {
			namespace: ns,
			sourceId,
			id: text(s.id, 200),
			version: text(s.version, 200),
			range: {
				start: Number(range.start),
				end: Number(range.end),
				unit: "unicode_code_points",
			},
			quote: text(s.quote, 32768),
		};
	});
}
/** Host composition only. Authentication repeats inside every transaction, including historical replay. */
export function createKnowledgeHost<Session>(
	installation: KnowledgeInstallation,
	authenticate: (session: Session) => Promise<Identity>,
) {
	const registry = createSourceRegistry(installation.sources),
		sealed = new WeakMap<
			object,
			{
				identity: Identity;
				snapshot: KnowledgePack;
				remote?: { tokenHash: string; consumerId: string; purpose: string };
			}
		>();
	const now = () => {
		const value = installation.now?.() ?? new Date();
		if (!Number.isFinite(value.getTime())) fail("invalid_clock", 503);
		return value;
	};
	async function authorizeSources(
		tx: KnowledgeTransaction,
		i: Identity,
		r: KnowledgeRecord,
	) {
		for (const ref of r.sources) {
			if (!same(ref.namespace, i.namespace) || !registry.has(ref.sourceId))
				fail("namespace_mismatch", 403);
			const current = await tx.source(i, ref);
			if (
				!same(current.namespace, i.namespace) ||
				current.id !== ref.id ||
				current.sourceId !== ref.sourceId
			)
				fail("source_denied", 403);
		}
	}
	async function qualify(
		tx: KnowledgeTransaction,
		i: Identity,
		r: KnowledgeRecord,
	) {
		const deadlines: string[] = [];
		for (const ref of [...r.sources].sort((a, b) =>
			JSON.stringify(a).localeCompare(JSON.stringify(b)),
		)) {
			if (!same(ref.namespace, i.namespace)) fail("namespace_mismatch", 403);
			const current = await tx.source(i, ref);
			if (
				!same(current.namespace, i.namespace) ||
				current.sourceId !== ref.sourceId ||
				current.id !== ref.id
			)
				fail("source_denied", 403);
			if (current.version !== ref.version) fail("source_changed", 409);
			if (
				!Number.isFinite(Date.parse(current.asOf)) ||
				Date.parse(current.asOf) > now().getTime() ||
				(current.expiresAt &&
					(!Number.isFinite(Date.parse(current.expiresAt)) ||
						Date.parse(current.expiresAt) <= now().getTime()))
			)
				fail("source_expired", 409);
			if (current.expiresAt) deadlines.push(current.expiresAt);
			const quote = Array.from(current.content)
				.slice(ref.range.start, ref.range.end)
				.join("");
			if (
				quote !== ref.quote ||
				Array.from(quote).length !== ref.range.end - ref.range.start
			)
				fail("evidence_mismatch", 409);
		}
		return deadlines;
	}
	function checkRecord(r: KnowledgeRecord) {
		if (r.status !== "verified") fail("review_required", 409);
		if (
			!Number.isFinite(Date.parse(r.reviewBy)) ||
			Date.parse(r.reviewBy) <= now().getTime()
		)
			fail("expired", 409);
		if (
			r.policy.id !== installation.policy.id ||
			r.policy.version !== installation.policy.version
		)
			fail("policy_changed", 409);
	}
	function entry(r: KnowledgeRecord): KnowledgeEntry {
		return {
			ref: { namespace: r.namespace, id: r.id, version: r.version },
			content: r.content,
			subject: r.subject,
			conditions: r.conditions,
			counterexample: r.counterexample,
			sources: r.sources,
			reviewBy: r.reviewBy,
			useSemantics:
				r.recordType === "constraint"
					? "safety_constraint"
					: "saved_interpretation",
		};
	}
	return {
		async forSession(session: Session) {
			const authenticated = await authenticate(session),
				identity = freeze({
					...authenticated,
					namespace: namespace(authenticated.namespace),
					principalId: text(authenticated.principalId, 200),
				});
			async function operation<T>(
				op: KnowledgeOperation,
				work: (tx: KnowledgeTransaction) => Promise<T>,
			) {
				return installation.store.transaction(async (tx) => {
					await tx.authorize(identity, op);
					return work(tx);
				});
			}
			return {
				capabilities: () => ({
					protocolVersion: PROTOCOL,
					implementationVersion: "general-memory.g5",
					provider: installation.store.provider,
					namespace: identity.namespace,
					levels: ["K", "U"],
					scope: installation.remoteBinding
						? "installed_gateway_consumers"
						: "installed_in_process_consumers_only",
					sources: registry.list().map((s) => s.id),
					policy: {
						id: installation.policy.id,
						version: installation.policy.version,
					},
					consumers: Object.keys(installation.consumers),
					retrieval: {
						modes: installation.semanticSearch ? ["keyword", "vector", "hybrid"] : ["keyword"],
						defaultMode: installation.semanticSearch?.defaultMode ?? "keyword",
						...(installation.semanticSearch ? {
							embeddingProvider: installation.semanticSearch.provider.id,
							dimensions: installation.semanticSearch.provider.dimensions,
							minSimilarity: installation.semanticSearch.minSimilarity ?? 0.3,
						} : {}),
					},
					remoteUse: installation.remoteBinding
						? {
								transport: "general-memory.http.v1",
								ttlSeconds: 60,
								singleUse: true,
								gatewayDispatchOnly: true,
							}
						: null,
					warnings: [
						"bounded_recall",
						"registered_edges_only",
						"no_independent_business_verification",
						...(installation.remoteBinding ? [] : ["no_remote_tokens"]),
					],
				}),
				async execute(value: unknown) {
					const c = object(value);
					keys(c, ["protocolVersion", "kind", "commandId", "payload"]);
					if (c.protocolVersion !== PROTOCOL) fail("unsupported_version", 422);
					const commandId = text(c.commandId, 200),
						kind = text(c.kind, 100),
						p = object(c.payload);
					if (
						![
							"interpretation.propose",
							"interpretation.review",
							"interpretation.revise",
							"interpretation.retire",
						].includes(kind)
					)
						fail("unsupported_capability", 422);
					const op: KnowledgeOperation =
						kind === "interpretation.propose"
							? "propose"
							: kind === "interpretation.review"
								? "review"
								: "revise";
					const allowed =
						kind === "interpretation.propose"
							? [
									"recordType",
									"scope",
									"subject",
									"content",
									"conditions",
									"counterexample",
									"tags",
									"sources",
									"reviewBy",
								]
							: kind === "interpretation.revise"
								? [
										"id",
										"expectedVersion",
										"reason",
										"content",
										"conditions",
										"counterexample",
										"sources",
									]
								: kind === "interpretation.review"
									? [
											"id",
											"expectedVersion",
											"reason",
											"decision",
											"evidenceConfirmed",
										]
									: ["id", "expectedVersion", "reason"];
					keys(p, allowed);
					const requestHash = digest(c);
					return operation(op, async (tx) => {
						const result = await runGovernedCommand<
							KnowledgeRecord,
							KnowledgeReceipt
						>({
							requestHash,
							authorize: async () => {},
							lock: () =>
								tx.lock(
									identity,
									`command:${identity.principalId}:${commandId}`,
								),
							prior: async () => {
								const r = await tx.command(identity, commandId);
								if (r) await authorizeSources(tx, identity, r.receipt.record);
								return r
									? {
											requestHash: r.requestHash,
											outcome: r.receipt.record,
											receipt: r.receipt,
										}
									: null;
							},
							conflict: () => fail("idempotency_conflict", 409),
							execute: async () => {
								const time = now().toISOString();
								let record: KnowledgeRecord;
								if (kind === "interpretation.propose") {
									const recordType = text(p.recordType, 100),
										scope = text(p.scope, 200),
										subject = text(p.subject, 1000),
										content = text(p.content, 12000),
										conditions = text(p.conditions, 2000),
										counterexample = text(p.counterexample, 2000);
									if (!Array.isArray(p.tags) || p.tags.length > 20)
										fail("invalid_request");
									const tags = p.tags.map((t) => text(t, 100));
									const sources = parseSources(
										p.sources,
										identity.namespace,
										(id) => registry.has(id),
									);
									const decision = evaluateBusinessPolicy(
										installation.policy,
										{
											recordType,
											originType: "interpretation",
											scopeType: scope,
											subject,
											content,
											tags,
											createdAt: time,
											attributes: {},
										},
										{ authorized: true, sourceVerified: false },
										now(),
									);
									if (
										decision.recordClass !== "long_term" ||
										decision.warnings.length ||
										!decision.reviewBy
									)
										fail("policy_rejected", 422);
									const reviewBy =
										p.reviewBy === undefined
											? decision.reviewBy
											: date(p.reviewBy);
									if (
										Date.parse(reviewBy) >
											Date.parse(time) + decision.reviewMaxDays * 86400000 ||
										Date.parse(reviewBy) <= Date.parse(time)
									)
										fail("invalid_review_deadline");
									const fingerprint = digest({
										namespace: identity.namespace,
										recordType,
										scope,
										subject,
										tags,
										content,
										conditions,
										counterexample,
										sources,
										policy: decision.trace.id,
										policyVersion: decision.trace.version,
									});
									await tx.lock(identity, `candidate:${fingerprint}`);
									const prior = await tx.byFingerprint(identity, fingerprint);
									if (prior) {
										await authorizeSources(tx, identity, prior);
										if (p.reviewBy !== undefined && prior.reviewBy !== reviewBy)
											fail("existing_deadline_conflict", 409);
										return prior;
									}
									const id = randomUUID();
									const data = {
										namespace: identity.namespace,
										id,
										rootId: id,
										status: "candidate" as const,
										recordType,
										scope,
										subject,
										content,
										conditions,
										counterexample,
										tags,
										sources,
										createdAt: time,
										updatedAt: time,
										reviewBy,
										policy: decision.trace,
										fingerprint,
									};
									record = { ...data, version: version(data) };
									await qualify(tx, identity, record);
								} else {
									const id = text(p.id, 200),
										expected = text(p.expectedVersion, 200),
										reason = text(p.reason, 2000);
									const current = await tx.record(identity, id, "update");
									if (!current) fail("not_found", 404);
									await authorizeSources(tx, identity, current);
									if (current.version !== expected)
										fail("version_conflict", 409);
									if (kind === "interpretation.review") {
										if (p.decision !== "accept" && p.decision !== "reject")
											fail("invalid_request");
										const accepting = p.decision === "accept";
										const issue = reviewTransitionIssue({
											expectedVersion: expected,
											currentVersion: current.version,
											pendingProposal: false,
											activating: accepting,
											retired: ["superseded", "retired", "rejected"].includes(
												current.status,
											),
											revised: Boolean(current.previousId),
											ownerReview: true,
											evidenceConfirmed: p.evidenceConfirmed === true,
											reason,
											ownerVerificationRequired: true,
										});
										if (issue) fail(issue, 409);
										if (accepting) {
											await qualify(tx, identity, current);
											if (
												!Number.isFinite(Date.parse(current.reviewBy)) ||
												Date.parse(current.reviewBy) <= now().getTime()
											)
												fail("expired", 409);
											if (
												current.policy.id !== installation.policy.id ||
												current.policy.version !== installation.policy.version
											)
												fail("policy_changed", 409);
										}
										record = {
											...current,
											status: accepting ? "verified" : "rejected",
											updatedAt: time,
										};
									} else {
										const issue = revisionTransitionIssue({
											expectedVersion: expected,
											currentVersion: current.version,
											sameIdentity: true,
											pendingProposal: false,
											restoring: false,
											restorable: false,
											retired: ["retired", "superseded", "rejected"].includes(
												current.status,
											),
										});
										if (issue) fail(issue, 409);
										if (kind === "interpretation.retire")
											record = {
												...current,
												status: "retired",
												updatedAt: time,
											};
										else {
											const sources = parseSources(
												p.sources,
												identity.namespace,
												(id) => registry.has(id),
											);
											if (
												Date.parse(current.reviewBy) <= now().getTime() &&
												digest(sources) === digest(current.sources)
											)
												fail("new_evidence_required", 409);
											const id = randomUUID(),
												data = {
													...current,
													id,
													previousId: current.id,
													status: "candidate" as const,
													content: text(p.content, 12000),
													conditions: text(p.conditions, 2000),
													counterexample: text(p.counterexample, 2000),
													sources,
													updatedAt: time,
												};
											const decision = evaluateBusinessPolicy(
												installation.policy,
												{
													recordType: data.recordType,
													originType: "interpretation",
													scopeType: data.scope,
													subject: data.subject,
													content: data.content,
													tags: data.tags,
													createdAt: data.createdAt,
													attributes: {},
												},
												{ authorized: true, sourceVerified: false },
												now(),
											);
											if (
												decision.recordClass !== "long_term" ||
												decision.warnings.length
											)
												fail("policy_rejected", 422);
											data.policy = decision.trace;
											data.fingerprint = digest({
												namespace: identity.namespace,
												recordType: data.recordType,
												scope: data.scope,
												subject: data.subject,
												tags: data.tags,
												content: data.content,
												conditions: data.conditions,
												counterexample: data.counterexample,
												sources: data.sources,
												policy: data.policy.id,
												policyVersion: data.policy.version,
											});
											await tx.lock(identity, `candidate:${data.fingerprint}`);
											const duplicate = await tx.byFingerprint(
												identity,
												data.fingerprint,
											);
											if (duplicate && duplicate.id !== current.id)
												fail("semantic_revision_conflict", 409);
											record = { ...data, version: version(data) };
											await qualify(tx, identity, record);
											const retired = {
												...current,
												status: "superseded" as const,
												updatedAt: time,
											};
											retired.version = version(retired);
											await tx.saveRecord(identity, retired);
										}
									}
									record.version = version(record);
								}
								await tx.saveRecord(identity, record);
								return record;
							},
							persist: async (record) => {
								const receipt: KnowledgeReceipt = {
									id: randomUUID(),
									commandId,
									kind,
									createdAt: now().toISOString(),
									record,
									semantics: "historical_command_outcome",
								};
								await tx.audit(identity, {
									id: receipt.id,
									kind,
									createdAt: receipt.createdAt,
									data: {
										recordId: record.id,
										version: record.version,
										commandId,
										reason: p.reason ?? null,
									},
								});
								await tx.saveCommand(identity, requestHash, receipt);
								return receipt;
							},
						});
						return { status: "committed" as const, ...result };
					});
				},
				async read(value: unknown) {
					const q = object(value);
					keys(q, ["purpose", "id", "commandId", "receiptId"]);
					if (q.purpose === "use_receipt")
						return operation("receipt", async (tx) => {
							const events = await tx.useReceipts(
								identity,
								text(q.receiptId, 200),
							);
							if (!events.length) return { status: "not_found" };
							return {
								status: "ok",
								semantics: "historical_use_outcome",
								state: events.some((e) => e.kind === "use_outcome_unknown")
									? "outcome_unknown"
									: events.some((e) => e.kind === "use_dispatched")
										? "dispatched"
										: "admitted",
								events,
							};
						});
					if (q.purpose === "receipt")
						return operation("receipt", async (tx) => {
							const r = await tx.command(identity, text(q.commandId, 200));
							if (r) await authorizeSources(tx, identity, r.receipt.record);
							return r
								? { status: "committed", receipt: r.receipt }
								: { status: "not_found" };
						});
					if (q.purpose !== "current") fail("unsupported_capability", 422);
					return operation("read", async (tx) => {
						const record = await tx.record(identity, text(q.id, 200), "share");
						if (!record) return { status: "not_found" };
						await authorizeSources(tx, identity, record);
						const receiptId = randomUUID();
						await tx.audit(identity, {
							id: receiptId,
							kind: "current_read",
							createdAt: now().toISOString(),
							data: { id: record.id, version: record.version },
						});
						return {
							status: "ok",
							record,
							receiptId,
							useSemantics: "governance_only",
						};
					});
				},
				async evidence(value: unknown) {
					const q = object(value);
					keys(q, ["ref"]);
					const [ref] = parseSources([q.ref], identity.namespace, (id) =>
						registry.has(id),
					);
					return operation("read", async (tx) => {
						await qualify(tx, identity, { sources: [ref] } as KnowledgeRecord);
						const receiptId = randomUUID();
						await tx.audit(identity, {
							id: receiptId,
							kind: "source_evidence_read",
							createdAt: now().toISOString(),
							data: { ref },
						});
						return { status: "ok", content: ref.quote, ref, receiptId };
					});
				},
				async recall(value: unknown): Promise<KnowledgePack> {
					const q = object(value);
					keys(q, ["scope", "query", "maxBytes", "retrieval"]);
					const scope = text(q.scope, 200),
						query = text(q.query, 2000);
					const maxBytes = q.maxBytes ?? 8192;
					if (
						!Number.isSafeInteger(maxBytes) ||
						Number(maxBytes) < 512 ||
						Number(maxBytes) > 65536
					)
						fail("invalid_request");
					const retrieval = parseRetrieval(q.retrieval, installation.semanticSearch);
					const result = await operation("recall", async (tx) => {
						const sourceDeadlines = new Map<string, string[]>();
						const checkCurrent = (r: KnowledgeRecord) => {
							checkRecord(r);
							if (sourceDeadlines.get(r.id)?.some((deadline) => Date.parse(deadline) <= now().getTime()))
								fail("source_expired", 409);
						};
						const { ranked, omissions, omissionCount: withheldCount } = await retrieveKnowledge({
							tx, identity, scope, query, retrieval, settings: installation.semanticSearch,
							qualify: async (r) => {
								checkRecord(r);
								sourceDeadlines.set(r.id, await qualify(tx, identity, r));
								checkCurrent(r);
							},
							checkCurrent,
						});
						let omissionCount = withheldCount;
						const selected = selectRecallCandidates({
							ranked,
							maxItems: 12 + ranked.filter((r) => r.recordType === "constraint").length,
							group: (r) => r.rootId,
							priority: (r) => r.recordType === "constraint",
							reserve: () => false,
							reserveLimit: 0,
							onDuplicate: (r) => {
								omissionCount++;
								if (omissions.length < 8) omissions.push({ id: r.id, reason: "duplicate_group" });
							},
							onReserved: () => {},
						});
						const receiptId = randomUUID(),
							entries = selected.map(entry),
							pack: KnowledgePack = {
								interfaceVersion: "general-memory.knowledge-context.v1",
								namespace: identity.namespace,
								principalId: identity.principalId,
								currentStates: [],
								historicalEvidence: selected.flatMap((r) =>
									r.sources.map((ref) => ({
										ref: {
											namespace: ref.namespace,
											id: ref.id,
											version: ref.version,
											kind: "source" as const,
										},
										content: ref.quote,
										subject: "Fixed source evidence",
										conditions:
											"Stored document evidence; not authoritative current business state.",
										counterexample:
											"A changed source or execution requires a new authorized observation.",
										sources: [ref],
										reviewBy: r.reviewBy,
										useSemantics: "raw_observation" as const,
									})),
								),
								interpretations: entries.filter(
									(e) => e.useSemantics !== "safety_constraint",
								),
								constraints: entries.filter(
									(e) => e.useSemantics === "safety_constraint",
								),
								openQuestions: omissions.map((o) => ({
									code: o.reason,
									detail:
										"A candidate was withheld; inspect governance and current evidence.",
								})),
								omissions,
								...(omissionCount > omissions.length ? { omissionSummary: { total: omissionCount, reported: omissions.length } } : {}),
								receiptId,
								budget: {
									maxTokens: Number(maxBytes),
									usedUpperBound: 0,
									unit: "utf8_bytes_upper_bound",
									truncated: omissionCount > omissions.length,
								},
								coverage: {
									candidateCoverage: "bounded",
									dependencyCoverage: "registered_edges_only",
									independentBusinessVerification: false,
								},
							};
						const budgeted = budgetContextPack<KnowledgeEntry, KnowledgePack>(
							pack,
						);
						if (!budgeted) fail("budget_exceeded", 409);
						await tx.audit(identity, {
							id: receiptId,
							kind: "recall",
							createdAt: now().toISOString(),
							data: {
								retrieval: {
									...retrieval,
									...(retrieval.mode !== "keyword" ? { provider: installation.semanticSearch!.provider.id } : {}),
								},
								refs: [
									...budgeted.constraints,
									...budgeted.interpretations,
									...budgeted.historicalEvidence,
								].map((e) => e.ref),
								omissions,
								omissionCount,
								budget: budgeted.budget,
							},
						});
						return budgeted;
					});
					const publicPack = freeze(structuredClone(result));
					sealed.set(publicPack, {
						identity,
						snapshot: structuredClone(result),
					});
					return publicPack;
				},
				async issueUse(pack: KnowledgePack, input: unknown) {
					const args = object(input);
					keys(args, ["consumerId", "purpose"]);
					const consumerId = text(args.consumerId, 200),
						purpose = text(args.purpose, 200);
					const ticket = sealed.get(pack),
						binding = installation.remoteBinding?.(identity);
					if (!binding) fail("unsupported_capability", 422);
					if (
						!ticket ||
						ticket.remote ||
						digest(ticket.identity) !== digest(identity)
					)
						fail("untrusted_context", 403);
					if (!Object.hasOwn(installation.consumers, consumerId))
						fail("unsupported_consumer", 422);
					const token = randomBytes(32).toString("base64url"),
						expiresAt = new Date(now().getTime() + 60_000).toISOString();
					await operation("use", async (tx) => {
						if (!tx.remoteUse) fail("unsupported_capability", 422);
						await tx.remoteUse.insert(identity, {
							tokenHash: digest(token),
							binding,
							consumerId,
							purpose,
							packHash: digest(ticket.snapshot),
							policyEpoch: digest([
								installation.policy.id,
								installation.policy.version,
							]),
							pack: ticket.snapshot,
							expiresAt,
						});
						await tx.audit(identity, {
							id: randomUUID(),
							kind: "remote_use_issued",
							createdAt: now().toISOString(),
							data: {
								packHash: digest(ticket.snapshot),
								consumerId,
								purpose,
								expiresAt,
							},
						});
					});
					return {
						credential: token,
						expiresAt,
						packHash: digest(ticket.snapshot),
						consumerId,
						purpose,
						semantics: "single_use_no_automatic_retry",
					};
				},
				async useStatus(input: unknown) {
					const args = object(input);
					keys(args, ["credential", "consumerId", "purpose"]);
					return operation("receipt", async (tx) => {
						if (!installation.remoteBinding || !tx.remoteUse)
							fail("unsupported_capability", 422);
						const r = await tx.remoteUse.get(
							identity,
							digest(text(args.credential, 100)),
						);
						if (
							!r ||
							r.binding !== installation.remoteBinding(identity) ||
							r.consumerId !== text(args.consumerId, 200) ||
							r.purpose !== text(args.purpose, 200)
						)
							fail("invalid_use_credential", 403);
						const events = r.admissionId
							? await tx.useReceipts(identity, r.admissionId)
							: [];
						return {
							state: events.some((e) => e.kind === "use_outcome_unknown")
								? "outcome_unknown"
								: events.some((e) => e.kind === "use_dispatched")
									? "dispatched"
									: r.admissionId
										? "admitted"
										: new Date(r.expiresAt).getTime() <= now().getTime()
											? "expired"
											: "issued",
							admissionId: r.admissionId ?? null,
							expiresAt: r.expiresAt,
							automaticRetry: false,
						};
					});
				},
				async dispatchRemote(
					input: unknown,
				): Promise<{ status: string; admissionId: string; output: unknown }> {
					const args = object(input);
					keys(args, ["credential", "consumerId", "purpose"]);
					const tokenHash = digest(text(args.credential, 100)),
						consumerId = text(args.consumerId, 200),
						purpose = text(args.purpose, 200);
					const pack = await operation("use", async (tx) => {
						if (!installation.remoteBinding || !tx.remoteUse)
							fail("unsupported_capability", 422);
						const ticket = await tx.remoteUse.get(identity, tokenHash);
						if (
							!ticket ||
							ticket.binding !== installation.remoteBinding(identity) ||
							ticket.consumerId !== consumerId ||
							ticket.purpose !== purpose
						)
							fail("invalid_use_credential", 403);
						if (ticket.admissionId) fail("use_already_consumed", 409);
						if (new Date(ticket.expiresAt).getTime() <= now().getTime())
							fail("use_credential_expired", 409);
						if (
							ticket.policyEpoch !==
								digest([installation.policy.id, installation.policy.version]) ||
							ticket.packHash !== digest(ticket.pack)
						)
							fail("use_binding_changed", 409);
						return freeze(structuredClone(ticket.pack));
					});
					sealed.set(pack, {
						identity,
						snapshot: pack,
						remote: { tokenHash, consumerId, purpose },
					});
					return this.dispatch(pack, consumerId);
				},
				async dispatch(pack: KnowledgePack, consumerId: string) {
					const ticket = sealed.get(pack);
					if (!ticket || digest(ticket.identity) !== digest(identity))
						fail("untrusted_context", 403);
					const consumer = Object.hasOwn(installation.consumers, consumerId)
						? installation.consumers[consumerId]
						: undefined;
					if (!consumer) fail("unsupported_consumer", 422);
					const snapshot = ticket.snapshot,
						entries = [...snapshot.constraints, ...snapshot.interpretations];
					if (!entries.length) fail("empty_context", 409);
					let admissionId = "";
					const guard = createUseGuard<KnowledgePack, never>({
						unavailable: () =>
							new MemoryError(
								"knowledge_dispatch_blocked",
								409,
								"Source, authority, version or audit could not be revalidated",
							),
						scope: (work) => work(),
						contextKey: () => digest(identity),
						contextVersions: (p) =>
							[
								...p.constraints,
								...p.interpretations,
								...p.historicalEvidence,
							].map((e) => ({
								identity: JSON.stringify([
									identity.namespace,
									e.ref.kind ?? "interpretation",
									e.ref.id,
								]),
								version: e.ref.version,
							})),
						merge: (_a, b) => ({ value: b, addedCount: entries.length }),
						proofKey: () => fail("unsupported_capability"),
						proofVersions: () => [],
						admit: async (_groups, _proofs, sequence, assertCurrent) =>
							operation("use", async (tx) => {
								const deadlines: string[] = [];
								// The credential row and current authority are locked until admission commits.
								if (ticket.remote) {
									if (!installation.remoteBinding || !tx.remoteUse)
										fail("unsupported_capability", 422);
									const r = await tx.remoteUse.get(
										identity,
										ticket.remote.tokenHash,
									);
									if (
										!r ||
										r.binding !== installation.remoteBinding(identity) ||
										r.consumerId !== consumerId ||
										r.purpose !== ticket.remote.purpose ||
										r.packHash !== digest(snapshot) ||
										r.policyEpoch !==
											digest([
												installation.policy.id,
												installation.policy.version,
											])
									)
										fail("invalid_use_credential", 403);
									if (r.admissionId) fail("use_already_consumed", 409);
									if (new Date(r.expiresAt).getTime() <= now().getTime())
										fail("use_credential_expired", 409);
								}
								if (!entries.length) fail("empty_context", 409);
								for (const e of [...entries].sort((a, b) =>
									a.ref.id.localeCompare(b.ref.id),
								)) {
									const r = await tx.record(identity, e.ref.id, "share");
									if (!r) fail("not_found", 404);
									checkRecord(r);
									deadlines.push(
										r.reviewBy,
										...(await qualify(tx, identity, r)),
									);
									if (r.version !== e.ref.version)
										fail("version_conflict", 409);
									if (
										assessDependencies({
											recorded: true,
											entityCurrent: r.version === e.ref.version,
											sourceAssessments: r.sources.map(() => "current"),
										}) !== "current"
									)
										fail("dependency_stale", 409);
								}
								for (const item of snapshot.historicalEvidence)
									deadlines.push(
										...(await qualify(tx, identity, {
											sources: item.sources,
										} as KnowledgeRecord)),
									);
								// Source locks may have waited past either credential's deadline.
								await tx.authorize(identity, "use");
								if (ticket.remote) {
									const current = await tx.remoteUse!.get(
										identity,
										ticket.remote.tokenHash,
									);
									if (
										!current ||
										new Date(current.expiresAt).getTime() <= now().getTime()
									)
										fail("use_credential_expired", 409);
								}
								if (
									deadlines.some(
										(value) => Date.parse(value) <= now().getTime(),
									)
								)
									fail("expired", 409);
								assertCurrent();
								admissionId = randomUUID();
								if (ticket.remote)
									await tx.remoteUse!.consume(
										identity,
										ticket.remote.tokenHash,
										admissionId,
									);
								await tx.audit(identity, {
									id: admissionId,
									kind: "use_admitted",
									createdAt: now().toISOString(),
									data: {
										consumerId,
										...(ticket.remote
											? { purpose: ticket.remote.purpose, remote: true }
											: {}),
										packHash: digest(snapshot),
										recallReceiptId: snapshot.receiptId,
										sequence,
									},
								});
							}),
					});
					return guard.run(async () => {
						guard.bind(true);
						guard.registerContext(snapshot);
						await guard.assertCurrent();
						try {
							const output = await consumer.send(
								freeze(structuredClone(snapshot)),
							);
							await operation("use", (tx) =>
								tx.audit(identity, {
									id: randomUUID(),
									kind: "use_dispatched",
									createdAt: now().toISOString(),
									data: { admissionId, consumerId },
								}),
							);
							return { status: "dispatched", admissionId, output };
						} catch {
							try {
								await operation("use", (tx) =>
									tx.audit(identity, {
										id: randomUUID(),
										kind: "use_outcome_unknown",
										createdAt: now().toISOString(),
										data: { admissionId, consumerId, automaticRetry: false },
									}),
								);
							} catch {}
							throw Object.assign(
								new MemoryError(
									"dispatch_outcome_unknown",
									503,
									"Delivery outcome is unknown; inspect the admission receipt before any retry",
								),
								{ admissionId },
							);
						}
					});
				},
			};
		},
	};
}
