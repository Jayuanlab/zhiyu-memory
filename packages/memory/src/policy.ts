import { digest } from "./core";
export type PolicyClass =
  | "long_term"
  | "run_record"
  | "acceptance_record"
  | "unclassified";
export type PolicyInput = {
  recordType: string;
  originType: string;
  scopeType: string;
  subject: string;
  content: string;
  tags: readonly string[];
  createdAt: string;
  expiresAt?: string;
  attributes: Record<string, unknown>;
};
export type PolicySuggestion = {
  recordClass: PolicyClass;
  reason: string;
  runWindowMs: number;
  reviewDefaultDays: number;
  reviewMaxDays: number;
  reviewRequired: boolean;
};
export type BusinessPolicy = {
  id: string;
  version: string;
  decide: (input: Readonly<PolicyInput>) => PolicySuggestion;
};
export type PolicyConstraints = {
  authorized?: boolean;
  sourceVerified?: boolean;
  reviewSatisfied?: boolean;
  reviewRequired?: boolean;
  denied?: boolean;
  expiresAt?: string;
  reviewBy?: string;
  maximumUsableUntil?: string;
  maximumReviewDays?: number;
  protectedClass?: PolicyClass;
};
export type PolicyTrace = {
  id: string;
  version: string;
  inputHash: string;
  decisionHash: string;
  inputSummary: {
    recordType: string;
    scopeType: string;
    contentHash: string;
    createdAt: string;
  };
};
export function isPolicyTrace(value: unknown): value is PolicyTrace {
  if (!value || typeof value !== "object") return false;
  const p = value as PolicyTrace;
  return (
    typeof p.id === "string" &&
    p.id.length > 0 &&
    p.id.length <= 200 &&
    typeof p.version === "string" &&
    p.version.length > 0 &&
    p.version.length <= 200 &&
    [p.inputHash, p.decisionHash, p.inputSummary?.contentHash].every(
      (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
    ) &&
    typeof p.inputSummary?.recordType === "string" &&
    typeof p.inputSummary?.scopeType === "string" &&
    typeof p.inputSummary?.createdAt === "string" &&
    Number.isFinite(Date.parse(p.inputSummary.createdAt))
  );
}
const classes: PolicyClass[] = [
  "long_term",
  "run_record",
  "acceptance_record",
  "unclassified",
];
/** Host-supplied policy only. The result is advice; it cannot issue a grant or manufacture source verification. */
export function evaluateBusinessPolicy(
  policy: BusinessPolicy,
  input: PolicyInput,
  hard: PolicyConstraints = {},
  now = new Date(),
) {
  const warnings: string[] = [];
  let suggestion: PolicySuggestion;
  try {
    if (!policy.id?.trim() || !policy.version?.trim()) throw Error();
    const raw = policy.decide(structuredClone(input));
    if (
      !raw ||
      typeof raw !== "object" ||
      Object.keys(raw).some(
        (k) =>
          ![
            "recordClass",
            "reason",
            "runWindowMs",
            "reviewDefaultDays",
            "reviewMaxDays",
            "reviewRequired",
          ].includes(k),
      ) ||
      !classes.includes(raw.recordClass) ||
      typeof raw.reason !== "string" ||
      !raw.reason.trim() ||
      !Number.isSafeInteger(raw.runWindowMs) ||
      raw.runWindowMs < 0 ||
      !Number.isSafeInteger(raw.reviewDefaultDays) ||
      !Number.isSafeInteger(raw.reviewMaxDays) ||
      raw.reviewDefaultDays < 1 ||
      raw.reviewDefaultDays > raw.reviewMaxDays ||
      raw.reviewMaxDays > 36500 ||
      typeof raw.reviewRequired !== "boolean"
    )
      throw Error();
    suggestion = { ...raw };
  } catch {
    warnings.push("policy_unavailable");
    suggestion = {
      recordClass: "unclassified",
      reason: "policy_unavailable",
      runWindowMs: 0,
      reviewDefaultDays: 1,
      reviewMaxDays: 1,
      reviewRequired: true,
    };
  }
  if (hard.reviewRequired) suggestion.reviewRequired = true;
  if (hard.protectedClass && suggestion.recordClass !== hard.protectedClass) {
    suggestion.recordClass = hard.protectedClass;
    suggestion.reason = "protected_record_class";
    warnings.push("protected_record_class");
  }
  if (hard.maximumReviewDays !== undefined) {
    if (
      !Number.isSafeInteger(hard.maximumReviewDays) ||
      hard.maximumReviewDays < 1
    ) {
      warnings.push("policy_constraints_invalid");
    } else {
      suggestion.reviewMaxDays = Math.min(
        suggestion.reviewMaxDays,
        hard.maximumReviewDays,
      );
      suggestion.reviewDefaultDays = Math.min(
        suggestion.reviewDefaultDays,
        suggestion.reviewMaxDays,
      );
    }
  }
  const end = Date.parse(input.createdAt) + suggestion.runWindowMs;
  const reviewEnd =
    Date.parse(input.createdAt) + suggestion.reviewDefaultDays * 86400_000;
  const deadlines = [
    hard.expiresAt,
    hard.reviewBy,
    hard.maximumUsableUntil,
    input.expiresAt,
  ].filter((v) => v !== undefined);
  const parsed = deadlines.map((v) => Date.parse(v!));
  if (
    !Number.isFinite(now.getTime()) ||
    parsed.some((v) => !Number.isFinite(v)) ||
    !Number.isFinite(end) ||
    Math.abs(end) > 8640000000000000 ||
    !Number.isFinite(reviewEnd) ||
    Math.abs(reviewEnd) > 8640000000000000
  )
    warnings.push("policy_constraints_invalid");
  const usableUntil =
    suggestion.recordClass === "run_record" &&
    Number.isFinite(end) &&
    Math.abs(end) <= 8640000000000000
      ? new Date(Math.min(end, ...parsed.filter(Number.isFinite))).toISOString()
      : null;
  const reviewBy =
    Number.isFinite(reviewEnd) && Math.abs(reviewEnd) <= 8640000000000000
      ? new Date(
          Math.min(reviewEnd, ...parsed.filter(Number.isFinite)),
        ).toISOString()
      : null;
  const blockers = [
    ...(hard.denied ? ["access_denied"] : []),
    ...(hard.authorized === true ? [] : ["authorization_unverified"]),
    ...(hard.sourceVerified === true ? [] : ["source_unverified"]),
    ...(suggestion.reviewRequired && hard.reviewSatisfied !== true
      ? ["review_required"]
      : []),
    ...(suggestion.recordClass !== "long_term"
      ? [`record_class:${suggestion.recordClass}`]
      : []),
    ...(parsed.some((v) => v <= now.getTime()) ? ["expired"] : []),
    ...(suggestion.recordClass === "long_term" &&
    (!reviewBy || Date.parse(reviewBy) <= now.getTime())
      ? ["review_expired"]
      : []),
    ...warnings,
  ];
  const trace: PolicyTrace = {
    id: policy.id || "unavailable",
    version: policy.version || "unknown",
    inputHash: digest(input),
    decisionHash: digest(suggestion),
    inputSummary: {
      recordType: input.recordType,
      scopeType: input.scopeType,
      contentHash: digest(input.content),
      createdAt: input.createdAt,
    },
  };
  return {
    ...suggestion,
    usableUntil,
    reviewBy,
    eligible: blockers.length === 0,
    blockers,
    warnings,
    trace,
  };
}
