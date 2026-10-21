import { randomBytes, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { digest } from "../../memory/src/core";
import type { Identity } from "../../memory/src/ports";
import { fail } from "../../memory/src/validation";

export async function initializeServiceIdentitySchema(sql: Sql) {
	await sql.begin(async (tx) => {
		await tx`CREATE TABLE IF NOT EXISTS general_memory_credentials_g5(id text PRIMARY KEY,token_hash text UNIQUE NOT NULL,tenant_id text NOT NULL,project_id text NOT NULL,principal_id text NOT NULL,epoch integer NOT NULL,allowed jsonb NOT NULL,denied jsonb NOT NULL,expires_at timestamptz NOT NULL,revoked boolean NOT NULL DEFAULT false)`;
		await tx`CREATE TABLE IF NOT EXISTS general_memory_identity_events_g5(id text PRIMARY KEY,credential_id text NOT NULL,kind text NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`;
		await tx.unsafe(
			"CREATE OR REPLACE FUNCTION general_memory_g5_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable identity event'; END $$",
		);
		await tx`DROP TRIGGER IF EXISTS general_memory_g5_identity_immutable ON general_memory_identity_events_g5`;
		await tx`CREATE TRIGGER general_memory_g5_identity_immutable BEFORE UPDATE OR DELETE ON general_memory_identity_events_g5 FOR EACH ROW EXECUTE FUNCTION general_memory_g5_identity_immutable()`;
	});
}
/** Admin-only provisioning methods are deliberately absent from HTTP. DB access is trusted installation authority. */
export function createServiceIdentityProvider(sql: Sql) {
	function identity(r: any): Identity {
		return {
			namespace: { tenantId: r.tenant_id, projectId: r.project_id },
			principalId: r.principal_id,
			traceId: JSON.stringify([r.id, r.epoch]),
		};
	}
	function current(r: any) {
		if (
			!r ||
			r.revoked ||
			new Date(r.expires_at).getTime() <= Date.now() ||
			!Array.isArray(r.allowed) ||
			!Array.isArray(r.denied) ||
			[...r.allowed, ...r.denied].some((x) => typeof x !== "string")
		)
			fail("credential_invalid", 401);
	}
	return {
		async authenticate(token: string) {
			const [r] =
				await sql`SELECT * FROM general_memory_credentials_g5 WHERE token_hash=${digest(token)}`;
			current(r);
			return identity(r);
		},
		async authorize(tx: TransactionSql, i: Identity, operation: string) {
			let binding: unknown;
			try {
				binding = JSON.parse(i.traceId);
			} catch {
				fail("credential_invalid", 401);
			}
			if (!Array.isArray(binding) || binding.length !== 2)
				fail("credential_invalid", 401);
			const [r] =
				await tx`SELECT * FROM general_memory_credentials_g5 WHERE id=${binding[0]} FOR SHARE`;
			current(r);
			if (
				digest(identity(r)) !== digest(i) ||
				r.denied.includes("*") ||
				r.denied.includes(operation) ||
				!r.allowed.includes(operation)
			)
				fail("credential_denied", 403);
		},
		binding: (i: Identity) => i.traceId,
		async replacePermissions(
			id: string,
			allowed: string[],
			denied: string[],
			actor: string,
		) {
			if (
				!actor.trim() ||
				!Array.isArray(allowed) ||
				!Array.isArray(denied) ||
				[...allowed, ...denied].some((x) => typeof x !== "string")
			)
				fail("invalid_credential_request");
			await sql.begin(async (tx) => {
				const r =
					await tx`UPDATE general_memory_credentials_g5 SET allowed=${tx.json(allowed)},denied=${tx.json(denied)},epoch=epoch+1 WHERE id=${id} AND NOT revoked RETURNING id`;
				if (!r.length) fail("not_found", 404);
				await tx`INSERT INTO general_memory_identity_events_g5(id,credential_id,kind,actor) VALUES(${randomUUID()},${id},'permissions_changed',${actor})`;
			});
		},
		async issue(
			i: Omit<Identity, "traceId">,
			allowed: string[],
			expiresAt: string,
			actor: string,
		) {
			if (
				!actor.trim() ||
				!i.namespace.tenantId ||
				!i.namespace.projectId ||
				!i.principalId ||
				!allowed.length ||
				allowed.some((x) => typeof x !== "string") ||
				!Number.isFinite(Date.parse(expiresAt)) ||
				Date.parse(expiresAt) <= Date.now()
			)
				fail("invalid_credential_request");
			const id = randomUUID(),
				token = randomBytes(32).toString("base64url");
			await sql.begin(async (tx) => {
				await tx`INSERT INTO general_memory_credentials_g5 VALUES(${id},${digest(token)},${i.namespace.tenantId},${i.namespace.projectId},${i.principalId},1,${tx.json(allowed)},'[]'::jsonb,${expiresAt},false)`;
				await tx`INSERT INTO general_memory_identity_events_g5(id,credential_id,kind,actor) VALUES(${randomUUID()},${id},'issued',${actor})`;
			});
			return { id, token, expiresAt };
		},
		async revoke(id: string, actor: string) {
			if (!actor.trim()) fail("actor_required");
			await sql.begin(async (tx) => {
				const r =
					await tx`UPDATE general_memory_credentials_g5 SET revoked=true,epoch=epoch+1 WHERE id=${id} RETURNING id`;
				if (!r.length) fail("not_found", 404);
				await tx`INSERT INTO general_memory_identity_events_g5(id,credential_id,kind,actor) VALUES(${randomUUID()},${id},'revoked',${actor})`;
			});
		},
	};
}
