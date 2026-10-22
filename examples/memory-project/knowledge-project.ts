import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { TransactionSql } from "postgres";
import { createMemoryHost } from "../../packages/memory/src/host";
import {
	initializeObservationSchema,
	createPostgresObservationStore,
} from "../../packages/memory-postgres/src/index";
import { createKnowledgeHost, type KnowledgeInstallation } from "../../packages/memory/src/knowledge";
import type { KnowledgePack } from "../../packages/memory/src/knowledge-contracts";
import type { Identity } from "../../packages/memory/src/ports";
import { fail } from "../../packages/memory/src/validation";
import {
	initializeKnowledgeSchema,
	createPostgresKnowledgeStore,
} from "../../packages/memory-postgres/src/knowledge";
import { developmentMemoryPolicy } from "./policy";
import { digest } from "../../packages/memory/src/core";
export function developmentDocumentVersion(value: {
	namespace: Identity["namespace"];
	id: string;
	version: string;
	content: string;
	asOf: string;
	expiresAt?: string;
}) {
	return `demodoc1:${digest(value)}`;
}
export type ProjectSession = object;
/** Identity issuance belongs to this project's authenticated server, never a request payload. */
export function createDevelopmentProject(
	sql: Sql,
	options: {
		now?: () => Date;
		deliver: (pack: Readonly<KnowledgePack>) => Promise<unknown>;
		/** Trusted server composition; not a client capability. */
		authenticate?: (session: ProjectSession) => Promise<Identity>;
		authorize?: (
			tx: TransactionSql,
			identity: Identity,
			operation: string,
		) => Promise<void>;
		remoteBinding?: (identity: Identity) => string;
		semanticSearch?: KnowledgeInstallation["semanticSearch"];
	},
) {
	const sessions = new WeakMap<object, Identity>();
	const authenticate = async (session: ProjectSession) => {
		if (options.authenticate) return options.authenticate(session);
		const identity = sessions.get(session);
		if (!identity) fail("untrusted_session", 403);
		return identity;
	};
	async function authorize(tx: TransactionSql, i: Identity, operation: string) {
		await options.authorize?.(tx, i, operation);
		const n = i.namespace,
			[member] =
				await tx`SELECT allowed,denied FROM demo_dev_members_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND principal_id=${i.principalId} FOR SHARE`;
		if (
			!member ||
			!Array.isArray(member.allowed) ||
			!Array.isArray(member.denied) ||
			member.allowed.some((value: unknown) => typeof value !== "string") ||
			member.denied.some((value: unknown) => typeof value !== "string") ||
			member.denied.includes(operation) ||
			member.denied.includes("*") ||
			!member.allowed.includes(operation)
		)
			fail("access_denied", 403);
	}
	const recordsHost = createMemoryHost(
		{
			store: createPostgresObservationStore(sql, (tx, i, op) =>
				authorize(tx, i, op === "append" ? "propose" : op),
			),
			sources: [
				{
					id: "demo.build",
					adapterVersion: "demo-dev.build.v1",
					kind: "build_log",
					trustLevel: "raw",
				},
			],
			now: options.now,
		},
		authenticate,
	);
	const store = createPostgresKnowledgeStore(sql, {
		authorize,
		async source(tx, i, ref) {
			const n = i.namespace;
			const [grant] =
				await tx`SELECT allowed,denied FROM demo_dev_source_grants_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND principal_id=${i.principalId} AND document_id=${ref.id} FOR SHARE`;
			if (!grant || grant.denied || !grant.allowed) fail("source_denied", 403);
			const [r] =
				await tx`SELECT version,content,as_of,expires_at FROM demo_dev_documents_g4 WHERE tenant_id=${n.tenantId} AND project_id=${n.projectId} AND id=${ref.id} FOR SHARE`;
			if (!r) fail("source_unavailable", 409);
			const current = {
				namespace: n,
				id: ref.id,
				version: r.version as string,
				content: r.content as string,
				asOf: new Date(r.as_of).toISOString(),
				...(r.expires_at
					? { expiresAt: new Date(r.expires_at).toISOString() }
					: {}),
			};
			return {
				...current,
				sourceId: "demo.document",
				version: developmentDocumentVersion(current),
			};
		},
	});
	const host = createKnowledgeHost(
		{
			store,
			policy: developmentMemoryPolicy,
			remoteBinding: options.remoteBinding,
			semanticSearch: options.semanticSearch,
			now: options.now,
			sources: [
				{
					id: "demo.document",
					adapterVersion: "demo-dev.documents.v1",
					kind: "document",
					trustLevel: "stored_project_source",
				},
			],
			consumers: { "demo.local-model": { send: options.deliver } },
		},
		authenticate,
	);
	return {
		async forSession(session: ProjectSession) {
			const knowledge = await host.forSession(session),
				records = await recordsHost.forSession(session);
			return {
				...knowledge,
				records,
				capabilities: () => ({
					...knowledge.capabilities(),
					levels: ["R", "K", "U"],
					records: records.capabilities(),
				}),
			};
		},
		/** Server-only login integration. This function is not exposed by the client. */
		issueAuthenticatedSession(
			identity: Omit<Identity, "traceId">,
		): ProjectSession {
			const session = Object.freeze({});
			sessions.set(
				session,
				structuredClone({ ...identity, traceId: randomUUID() }),
			);
			return session;
		},
	};
}
/** Explicit fresh-project bootstrap. The ordinary application never calls it. */
export async function initializeDevelopmentProject(sql: Sql) {
	await initializeObservationSchema(sql);
	await initializeKnowledgeSchema(sql);
	await sql.begin(async (tx) => {
		await tx`CREATE TABLE IF NOT EXISTS demo_dev_members_g4(tenant_id text NOT NULL,project_id text NOT NULL,principal_id text NOT NULL,allowed jsonb NOT NULL,denied jsonb NOT NULL,PRIMARY KEY(tenant_id,project_id,principal_id))`;
		await tx`CREATE TABLE IF NOT EXISTS demo_dev_documents_g4(tenant_id text NOT NULL,project_id text NOT NULL,id text NOT NULL,version text NOT NULL,content text NOT NULL,as_of timestamptz NOT NULL,expires_at timestamptz,PRIMARY KEY(tenant_id,project_id,id))`;
		await tx`CREATE TABLE IF NOT EXISTS demo_dev_source_grants_g4(tenant_id text NOT NULL,project_id text NOT NULL,principal_id text NOT NULL,document_id text NOT NULL,allowed boolean NOT NULL,denied boolean NOT NULL DEFAULT false,PRIMARY KEY(tenant_id,project_id,principal_id,document_id))`;
	});
}
