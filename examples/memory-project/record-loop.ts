import { PROTOCOL } from "../../packages/memory/src/index";
import type { bindClient } from "../../packages/memory/src/host";
/** A second consumer: no Zhiyu imports, database schema, Work, Loop or Next.js. */
export async function runRecordLoop(
  client: ReturnType<typeof bindClient>,
  commandId = "example-ci-1",
) {
  const command = {
    protocolVersion: PROTOCOL,
    kind: "observation.append",
    commandId,
    payload: {
      source: {
        sourceId: "demo.build",
        externalId: "job-1",
        version: "commit-abc",
      },
      observedAt: "2026-10-21T01:00:00Z",
      content: "Build timed out. 🧭\nCheck the job status before retrying.",
    },
  };
  const saved = await client.execute(command),
    retry = await client.execute(command);
  const exact = await client.read({
    purpose: "evidence",
    ref: saved.ref,
    range: { start: 0, end: 16, unit: "unicode_code_points" },
  });
  const receipt = await client.read({ purpose: "receipt", commandId });
  return { saved, retry, exact, receipt };
}
