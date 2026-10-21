import type { Namespace } from "./contracts";
import type { Identity } from "./ports";
import type { PolicyTrace } from "./policy";
export type KnowledgeOperation =
	| "propose"
	| "review"
	| "revise"
	| "recall"
	| "read"
	| "receipt"
	| "use";
export type KnowledgeSourceRef = {
	namespace: Namespace;
	sourceId: string;
	id: string;
	version: string;
	range: { start: number; end: number; unit: "unicode_code_points" };
	quote: string;
};
export type KnowledgeSource = {
	namespace: Namespace;
	sourceId: string;
	id: string;
	version: string;
	content: string;
	asOf: string;
	expiresAt?: string;
};
export type KnowledgeRecord = {
	namespace: Namespace;
	id: string;
	rootId: string;
	version: string;
	status: "candidate" | "verified" | "superseded" | "retired" | "rejected";
	recordType: string;
	scope: string;
	subject: string;
	content: string;
	conditions: string;
	counterexample: string;
	tags: string[];
	sources: KnowledgeSourceRef[];
	createdAt: string;
	updatedAt: string;
	reviewBy: string;
	policy: PolicyTrace;
	fingerprint: string;
	previousId?: string;
};
export type KnowledgeReceipt = {
	id: string;
	commandId: string;
	kind: string;
	createdAt: string;
	record: KnowledgeRecord;
	semantics: "historical_command_outcome";
};
export type KnowledgeEntry = {
	ref: {
		namespace: Namespace;
		id: string;
		version: string;
		kind?: "interpretation" | "source";
	};
	content: string;
	subject: string;
	conditions: string;
	counterexample: string;
	sources: KnowledgeSourceRef[];
	reviewBy: string;
	useSemantics:
		| "saved_interpretation"
		| "safety_constraint"
		| "raw_observation";
	truncated?: boolean;
	truncationReason?: string;
};
export type KnowledgePack = {
	interfaceVersion: "general-memory.knowledge-context.v1";
	namespace: Namespace;
	principalId: string;
	currentStates: KnowledgeEntry[];
	historicalEvidence: KnowledgeEntry[];
	interpretations: KnowledgeEntry[];
	constraints: KnowledgeEntry[];
	openQuestions: Array<{ code: string; detail: string }>;
	omissions: Array<{ id: string; reason: string }>;
	receiptId: string;
	budget: {
		maxTokens: number;
		usedUpperBound: number;
		unit: "utf8_bytes_upper_bound";
		truncated: boolean;
	};
	coverage: {
		candidateCoverage: "bounded";
		dependencyCoverage: "registered_edges_only";
		independentBusinessVerification: false;
	};
};
export type KnowledgeAudit = {
	id: string;
	kind: string;
	createdAt: string;
	data: Record<string, unknown>;
};
export interface KnowledgeTransaction {
	/** Optional durable remote-use repository. All methods share this transaction. */
	remoteUse?: {
		insert(identity: Identity, ticket: RemoteUseTicket): Promise<void>;
		get(identity: Identity, tokenHash: string): Promise<RemoteUseTicket | null>;
		consume(
			identity: Identity,
			tokenHash: string,
			admissionId: string,
		): Promise<void>;
	};
	/** Must lock current authority until commit. Denied is evaluated before any allow. */
	authorize(identity: Identity, operation: KnowledgeOperation): Promise<void>;
	lock(identity: Identity, key: string): Promise<void>;
	command(
		identity: Identity,
		id: string,
	): Promise<{ requestHash: string; receipt: KnowledgeReceipt } | null>;
	saveCommand(
		identity: Identity,
		hash: string,
		receipt: KnowledgeReceipt,
	): Promise<void>;
	record(
		identity: Identity,
		id: string,
		lock: "share" | "update",
	): Promise<KnowledgeRecord | null>;
	byFingerprint(
		identity: Identity,
		fingerprint: string,
	): Promise<KnowledgeRecord | null>;
	list(
		identity: Identity,
		scope: string,
		limit: number,
	): Promise<KnowledgeRecord[]>;
	saveRecord(identity: Identity, record: KnowledgeRecord): Promise<void>;
	/** Source Adapter authorizes identity AND source, holds source/authority locks through audit. */
	source(identity: Identity, ref: KnowledgeSourceRef): Promise<KnowledgeSource>;
	audit(identity: Identity, audit: KnowledgeAudit): Promise<void>;
	useReceipts(
		identity: Identity,
		admissionId: string,
	): Promise<KnowledgeAudit[]>;
}
export type RemoteUseTicket = {
	tokenHash: string;
	binding: string;
	consumerId: string;
	purpose: string;
	packHash: string;
	policyEpoch: string;
	pack: KnowledgePack;
	expiresAt: string;
	admissionId?: string;
};
export interface KnowledgeStore {
	provider: string;
	transaction<T>(work: (tx: KnowledgeTransaction) => Promise<T>): Promise<T>;
}
