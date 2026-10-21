/** Trusted storage callbacks must share one transaction, including authority and source locks. */
export async function runGovernedCommand<Outcome, Receipt>(input: {
	requestHash: string;
	authorize(): Promise<void>;
	lock(): Promise<void>;
	prior(): Promise<{
		requestHash: string;
		outcome: Outcome;
		receipt: Receipt;
	} | null>;
	execute(): Promise<Outcome>;
	persist(outcome: Outcome): Promise<Receipt>;
	conflict(): never;
}) {
	await input.authorize();
	await input.lock();
	const prior = await input.prior();
	if (prior && prior.requestHash !== input.requestHash) input.conflict();
	if (prior)
		return { outcome: prior.outcome, receipt: prior.receipt, replayed: true };
	const outcome = await input.execute();
	const receipt = await input.persist(outcome);
	if (receipt == null) throw new Error("governance_audit_unavailable");
	return { outcome, receipt, replayed: false };
}

export type DependencyAssessment = "unknown" | "current" | "stale" | "denied";
/** A registered edge is bounded coverage, never a claim that no other dependency exists. */
export function assessDependencies(input: {
	recorded: boolean;
	entityCurrent: boolean;
	sourceAssessments: readonly DependencyAssessment[];
}): DependencyAssessment {
	if (input.sourceAssessments.includes("denied")) return "denied";
	if (!input.recorded) return "unknown";
	return input.entityCurrent &&
		input.sourceAssessments.length > 0 &&
		input.sourceAssessments.every((s) => s === "current")
		? "current"
		: "stale";
}

/** Evaluate the locked version. Project-specific evidence rules supply additional blocking issues. */
export function reviewTransitionIssue(input: {
	expectedVersion?: string;
	currentVersion: string;
	pendingProposal: boolean;
	activating: boolean;
	retired: boolean;
	revised: boolean;
	ownerReview: boolean;
	evidenceConfirmed: boolean;
	reason?: string | null;
	ownerVerificationRequired: boolean;
}):
	| "proposal_pending"
	| "version_conflict"
	| "revision_required"
	| "retired"
	| "revision_verification_required"
	| "owner_verification_required"
	| null {
	if (input.pendingProposal) return "proposal_pending";
	if (input.expectedVersion && input.expectedVersion !== input.currentVersion)
		return "version_conflict";
	if (!input.activating && input.revised) return "revision_required";
	if (input.activating && input.retired) return "retired";
	const checked =
		input.ownerReview &&
		Boolean(input.expectedVersion) &&
		input.evidenceConfirmed &&
		Boolean(input.reason?.trim());
	if (input.activating && input.revised && !checked)
		return "revision_verification_required";
	if (input.activating && input.ownerVerificationRequired && !checked)
		return "owner_verification_required";
	return null;
}

export function revisionTransitionIssue(input: {
	expectedVersion: string;
	currentVersion: string;
	sameIdentity: boolean;
	pendingProposal: boolean;
	restoring: boolean;
	restorable: boolean;
	retired: boolean;
}): "proposal_pending" | "version_conflict" | "inactive" | null {
	if (input.pendingProposal) return "proposal_pending";
	if (input.expectedVersion !== input.currentVersion || !input.sameIdentity)
		return "version_conflict";
	if (input.restoring ? !input.restorable : input.retired) return "inactive";
	return null;
}
