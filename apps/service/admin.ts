import fs from "node:fs";
import postgres from "postgres";
import { initializeDevelopmentProject } from "../../examples/memory-project/knowledge-project";
import {
	createServiceIdentityProvider,
	initializeServiceIdentitySchema,
} from "../../packages/memory-postgres/src/service-identity";

/** Local operator CLI, never registered as an agent tool or HTTP route. Credentials never go to stdout. */
async function main() {
	const url = process.env.MEMORY_SERVICE_DATABASE_URL;
	if (!url) throw Error("MEMORY_SERVICE_DATABASE_URL_required");
	const sql = postgres(url, { max: 1, onnotice: () => {} });
	try {
		const auth = createServiceIdentityProvider(sql);
		const action = process.argv[2];
		if (action === "init") {
			await initializeDevelopmentProject(sql);
			await initializeServiceIdentitySchema(sql);
			console.log(
				JSON.stringify({ initialized: true, applicationMigrationsRun: false }),
			);
			return;
		}
		if (!process.argv[3]) throw Error("private_operator_json_file_required");
		const input = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
		if (action === "issue") {
			// Reserve the protected output path before issuing, so an accidental overwrite cannot lose a key.
			const fd = fs.openSync(input.outputFile, "wx", 0o600);
			try {
				const result = await auth.issue(
					input.identity,
					input.allowed,
					input.expiresAt,
					input.actor,
				);
				fs.writeFileSync(fd, JSON.stringify(result));
				console.log(
					JSON.stringify({
						credentialId: result.id,
						savedTo: input.outputFile,
						expiresAt: result.expiresAt,
					}),
				);
			} finally {
				fs.closeSync(fd);
			}
		} else if (action === "revoke") {
			await auth.revoke(input.id, input.actor);
			console.log(JSON.stringify({ revoked: true, credentialId: input.id }));
		} else if (action === "permissions") {
			await auth.replacePermissions(
				input.id,
				input.allowed,
				input.denied,
				input.actor,
			);
			console.log(JSON.stringify({ updated: true, credentialId: input.id }));
		} else throw Error("unknown_admin_action");
	} finally {
		await sql.end();
	}
}
main().catch(() => {
	console.error(
		"Operator command failed; inspect private input and database state. No credential was logged.",
	);
	process.exitCode = 1;
});
