import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBusinessPolicy,
  type PolicyInput,
  type BusinessPolicy,
} from "../src/policy";
import { developmentMemoryPolicy } from "../../../examples/memory-project/policy";
import { createSourceRegistry } from "../src/sources";
const input: PolicyInput = {
  recordType: "report",
  originType: "ci",
  scopeType: "repository",
  subject: "Build",
  content: "Build failed at commit abc",
  tags: ["build-log"],
  createdAt: "2026-10-21T00:00:00Z",
  attributes: {},
};
const now = new Date("2026-10-21T01:00:00Z"),
  all = { authorized: true, sourceVerified: true, reviewSatisfied: true };
test("policy's default review deadline stops a stale conclusion even without an explicit expiry", () => {
  const d = evaluateBusinessPolicy(
    developmentMemoryPolicy,
    { ...input, tags: ["team-rule"] },
    all,
    new Date("2027-02-01T00:00:00Z"),
  );
  assert.equal(d.eligible, false);
  assert.ok(d.blockers.includes("review_expired"));
  assert.equal(d.reviewBy, "2027-01-19T00:00:00.000Z");
});
test("second project has its own 2-hour / 90-day policy and unknown quarantine", () => {
  const a = evaluateBusinessPolicy(developmentMemoryPolicy, input, all, now);
  assert.equal(a.usableUntil, "2026-10-21T02:00:00.000Z");
  assert.equal(a.eligible, false);
  assert.equal(a.reviewDefaultDays, 90);
  assert.equal(
    evaluateBusinessPolicy(
      developmentMemoryPolicy,
      { ...input, tags: [] },
      all,
      now,
    ).recordClass,
    "unclassified",
  );
  assert.equal(
    evaluateBusinessPolicy(
      developmentMemoryPolicy,
      { ...input, tags: ["team-rule"] },
      all,
      now,
    ).eligible,
    true,
  );
});
test("denial, pending review, source failure, explicit expiry and malformed deadlines cannot be relaxed", () => {
  const approved = { ...input, tags: ["team-rule"] };
  for (const hard of [
    { ...all, denied: true },
    { ...all, sourceVerified: false },
    { ...all, authorized: false },
    { ...all, reviewSatisfied: false },
    { ...all, expiresAt: "2026-10-21T00:01:00Z" },
    { ...all, reviewBy: "invalid" },
  ])
    assert.equal(
      evaluateBusinessPolicy(developmentMemoryPolicy, approved, hard, now)
        .eligible,
      false,
    );
  const malicious: BusinessPolicy = {
    ...developmentMemoryPolicy,
    decide: () => ({
      recordClass: "long_term",
      reason: "skip",
      runWindowMs: 999999,
      reviewDefaultDays: 180,
      reviewMaxDays: 180,
      reviewRequired: false,
    }),
  };
  assert.equal(
    evaluateBusinessPolicy(
      malicious,
      approved,
      { ...all, reviewRequired: true, reviewSatisfied: false },
      now,
    ).eligible,
    false,
  );
});
test("a plugin cannot add allow/grant fields or bypass protected classes", () => {
  const broken = {
    ...developmentMemoryPolicy,
    decide: () => ({ ...developmentMemoryPolicy.decide(input), allowed: true }),
  };
  const a = evaluateBusinessPolicy(broken, input, all, now);
  assert.equal(a.recordClass, "unclassified");
  assert.equal(a.eligible, false);
  assert.deepEqual(a.warnings, ["policy_unavailable"]);
  const b = evaluateBusinessPolicy(
    developmentMemoryPolicy,
    input,
    { ...all, protectedClass: "long_term" },
    now,
  );
  assert.equal(b.recordClass, "long_term");
  assert.equal(b.eligible, false);
});
test("hard deadlines and maxima constrain advice; provenance is stable and contains no raw text", () => {
  const a = evaluateBusinessPolicy(
    developmentMemoryPolicy,
    input,
    {
      ...all,
      maximumUsableUntil: "2026-10-21T01:30:00Z",
      maximumReviewDays: 30,
    },
    now,
  );
  assert.equal(a.usableUntil, "2026-10-21T01:30:00.000Z");
  assert.equal(a.reviewDefaultDays, 30);
  assert.deepEqual(
    a.trace,
    evaluateBusinessPolicy(
      developmentMemoryPolicy,
      structuredClone(input),
      {
        ...all,
        maximumUsableUntil: "2026-10-21T01:30:00Z",
        maximumReviewDays: 30,
      },
      now,
    ).trace,
  );
  assert.ok(!JSON.stringify(a.trace).includes(input.content));
  assert.notEqual(
    a.trace.inputHash,
    evaluateBusinessPolicy(
      developmentMemoryPolicy,
      { ...input, content: "different" },
      all,
      now,
    ).trace.inputHash,
  );
});
test("registry is host-installed, copied, duplicate-checked and has no request mutation API", () => {
  const descriptor = {
      id: "ci",
      adapterVersion: "1",
      kind: "raw",
      trustLevel: "raw",
    },
    r = createSourceRegistry([descriptor]);
  descriptor.id = "forged";
  assert.equal(r.has("forged"), false);
  assert.equal(r.has("ci"), true);
  assert.equal(r.get("not-registered"), undefined);
  assert.throws(() => createSourceRegistry([descriptor, descriptor]));
  assert.throws(() =>
    createSourceRegistry([{ ...descriptor, adapterVersion: "" }]),
  );
});
