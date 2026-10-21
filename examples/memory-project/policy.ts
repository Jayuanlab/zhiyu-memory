import type { BusinessPolicy } from "../../packages/memory/src/policy";
/** A second project's actual policy: no market keywords, Work, Loop, Next or Zhiyu scope. */
export const developmentMemoryPolicy: BusinessPolicy = {
  id: "demo-dev.memory.records",
  version: "1.0.0",
  decide(input) {
    return {
      recordClass: input.tags.includes("build-log")
        ? "run_record"
        : input.tags.includes("team-rule")
          ? "long_term"
          : "unclassified",
      reason: input.tags.includes("build-log")
        ? "build_execution_log"
        : input.tags.includes("team-rule")
          ? "reviewable_team_rule"
          : "unknown_record",
      runWindowMs: 2 * 3600_000,
      reviewDefaultDays: 90,
      reviewMaxDays: 180,
      reviewRequired: true,
    };
  },
};
