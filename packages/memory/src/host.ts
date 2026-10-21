import { randomUUID } from "node:crypto";
import { bindClient, type Installation } from "./core";
import { fail, namespace, text } from "./validation";
import type { Identity } from "./ports";
/** Trusted server composition only. Authentication runs again for every operation in Store.authorize. */
export function createMemoryHost<Session>(
	installation: Installation,
	authenticate: (
		session: Session,
	) => Promise<Omit<Identity, "traceId"> & { traceId?: string }>,
) {
	return {
		async forSession(session: Session) {
			const identity = await authenticate(session);
			return bindClient(installation, {
				namespace: namespace(identity.namespace),
				principalId: text(identity.principalId, 200),
				traceId: identity.traceId ?? randomUUID(),
			});
		},
	};
}
export { fail, bindClient };
export type { Installation };
