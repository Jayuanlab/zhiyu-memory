import postgres from "postgres";
import { createMemoryHttpServer } from "../../packages/memory/src/http";
import { createServiceIdentityProvider } from "../../packages/memory-postgres/src/service-identity";
import { createDevelopmentProject } from "../../examples/memory-project/knowledge-project";
import type { Identity } from "../../packages/memory/src/ports";
import { fail } from "../../packages/memory/src/validation";
import { embeddingFromEnvironment } from "./embedding";
import { loadStandardProjects } from "./standard-projects";

/** Example deployment composition, not a Zhiyu migration or an unauthenticated bootstrap endpoint. */
const url = process.env.MEMORY_SERVICE_DATABASE_URL;
if (!url) throw Error("MEMORY_SERVICE_DATABASE_URL_required");
const consumerUrl = process.env.MEMORY_SERVICE_CONSUMER_URL;
if (!consumerUrl) throw Error("MEMORY_SERVICE_CONSUMER_URL_required");
const semanticSearch = embeddingFromEnvironment();
const destination = new URL(consumerUrl);
if (
	destination.protocol !== "http:" ||
	destination.hostname !== "127.0.0.1" ||
	destination.username ||
	destination.password
)
	throw Error("example_consumer_must_be_loopback");
const sql = postgres(url, { max: 8, onnotice: () => {} });
try {
	const required = [
		...(semanticSearch ? ["general_memory_embeddings_g6"] : []),
		"general_memory_observations_g1",
		"general_memory_commands_g1",
		"general_memory_reads_g1",
		"general_memory_knowledge_g4",
		"general_memory_knowledge_history_g4",
		"general_memory_knowledge_commands_g4",
		"general_memory_knowledge_audits_g4",
		"general_memory_remote_use_g5",
		"general_memory_credentials_g5",
		"general_memory_identity_events_g5",
		"demo_dev_members_g4",
		"demo_dev_documents_g4",
		"demo_dev_source_grants_g4",
	];
	const present =
		await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ${sql(required)}`;
	if (required.some((name) => !present.some((row) => row.tablename === name)))
		throw Error("service_schema_not_initialized");
} catch {
	await sql.end();
	throw Error("service_schema_unavailable_or_not_initialized");
}
const auth = createServiceIdentityProvider(sql),
	sessions = new WeakMap<object, Identity>();
const authenticate = async (session: object) => sessions.get(session) ?? fail("untrusted_session", 401);
const standardProject = await loadStandardProjects(process.env.MEMORY_SERVICE_STANDARD_PROJECTS_FILE,
  {sql, auth, authenticate, semanticSearch});
const project = createDevelopmentProject(sql, {
	authenticate: async (session) =>
		sessions.get(session) ?? fail("untrusted_session", 401),
	authorize: auth.authorize,
	remoteBinding: auth.binding,
	semanticSearch,
	deliver: async (pack) => {
		const response = await fetch(destination, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(pack),
			redirect: "error",
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) throw Error("consumer_failed");
		// Consumer acknowledgement is its response, not proof of downstream business success.
		return { acknowledged: response.status === 200 };
	},
});
const server = createMemoryHttpServer({
	clientForBearer: async (token) => {
		const identity = await auth.authenticate(token),
			session = Object.freeze({});
		sessions.set(session, identity);
		return (standardProject(identity) ?? project).forSession(session);
	},
});
server.listen(Number(process.env.MEMORY_SERVICE_PORT ?? 0), "127.0.0.1", () => {
	const address = server.address();
	if (!address || typeof address === "string")
		throw Error("listener_unavailable");
	const status = { ready: true, port: address.port, pid: process.pid };
	if (process.send) process.send(status);
	else console.log(JSON.stringify(status));
});
let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	server.close();
	server.closeIdleConnections();
	await sql.end({ timeout: 5 });
	process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", (message) => {
	if (message === "stop") void stop();
});
