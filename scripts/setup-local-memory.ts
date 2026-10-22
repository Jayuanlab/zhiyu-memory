import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { initializeDevelopmentProject } from "../examples/memory-project/knowledge-project";
import {
  initializeServiceIdentitySchema, createServiceIdentityProvider,
} from "../packages/memory-postgres/src/service-identity";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "private/local-memory");
const namespace = { tenantId: "local", projectId: "memory-lab" };
const container = "zhiyu-memory-local-postgres";
const volume = "zhiyu-memory-local-postgres-data";
const serviceFile = path.join(directory, "service.json");
const writePrivate = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
function docker(args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function main() {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(serviceFile)) {
    const password = randomBytes(32).toString("hex");
    fs.writeFileSync(path.join(directory, "postgres.env"),
      `POSTGRES_USER=memory\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=zhiyu_memory_local\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" });
    writePrivate(serviceFile, { env: {
      MEMORY_SERVICE_PROJECT_MODULE: "",
      MEMORY_SERVICE_DATABASE_URL: `postgres://memory:${password}@127.0.0.1:5433/zhiyu_memory_local`,
      MEMORY_SERVICE_PORT: "3642",
      MEMORY_SERVICE_CONSUMER_URL: "http://127.0.0.1:3643/model",
      MEMORY_EMBEDDING_URL: "http://127.0.0.1:11434/v1/embeddings",
      MEMORY_EMBEDDING_MODEL: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
      MEMORY_EMBEDDING_DIMENSIONS: "384",
    } });
  }
  const config = JSON.parse(fs.readFileSync(serviceFile, "utf8"));
  const databaseUrl = new URL(config.env.MEMORY_SERVICE_DATABASE_URL);
  if (databaseUrl.hostname !== "127.0.0.1" || databaseUrl.port !== "5433" || databaseUrl.pathname !== "/zhiyu_memory_local")
    throw Error("unexpected_local_database_configuration");
  let inspected: any;
  try { inspected = JSON.parse(docker(["inspect", "--type", "container", container]))[0]; }
  catch { /* Missing container is initialized below. */ }
  if (inspected) {
    if (inspected.Config.Labels?.["local.zhiyu-memory"] !== "memory-lab")
      throw Error("container_name_owned_by_another_deployment");
    if (!inspected.State.Running) docker(["start", container]);
  } else {
    docker(["run", "--detach", "--name", container, "--restart", "unless-stopped",
      "--label", "local.zhiyu-memory=memory-lab", "--env-file", path.join(directory, "postgres.env"),
      "--publish", "127.0.0.1:5433:5432", "--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data`,
      "postgres:16"]);
  }
  const sql = postgres(databaseUrl.href, { max: 2, connect_timeout: 2, onnotice: () => {} });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await sql`SELECT 1`; ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!ready) throw Error("local_postgres_not_ready");
    await initializeDevelopmentProject(sql);
    await initializeServiceIdentitySchema(sql);
    const auth = createServiceIdentityProvider(sql);
    const roles = [
      { principalId: "local-agent", file: "agent-credential.json", allowed: ["propose", "read", "receipt", "recall", "use", "revise"] },
      { principalId: "local-reviewer", file: "reviewer-credential.json", allowed: ["review", "read", "receipt"] },
    ];
    const credentials: Array<{ principalId: string; expiresAt: string }> = [];
    for (const role of roles) {
      await sql`INSERT INTO demo_dev_members_g4(tenant_id,project_id,principal_id,allowed,denied)
        VALUES(${namespace.tenantId},${namespace.projectId},${role.principalId},${sql.json(role.allowed)},'[]'::jsonb)
        ON CONFLICT(tenant_id,project_id,principal_id) DO NOTHING`;
      const file = path.join(directory, role.file);
      let credential;
      if (fs.existsSync(file)) {
        credential = JSON.parse(fs.readFileSync(file, "utf8"));
        const identity = await auth.authenticate(credential.token);
        if (identity.namespace.tenantId !== namespace.tenantId || identity.namespace.projectId !== namespace.projectId || identity.principalId !== role.principalId)
          throw Error("local_credential_identity_mismatch");
      } else {
        const fd = fs.openSync(file, "wx", 0o600);
        try {
          credential = await auth.issue({ namespace, principalId: role.principalId }, role.allowed,
            new Date(Date.now() + 30 * 86400000).toISOString(), "authorized-local-memory-setup");
          fs.writeFileSync(fd, JSON.stringify(credential, null, 2) + "\n", "utf8");
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
      }
      credentials.push({ principalId: role.principalId, expiresAt: credential.expiresAt });
    }
    const profileFile = path.join(directory, "skill-profile.json");
    if (!fs.existsSync(profileFile)) writePrivate(profileFile, {
      baseUrl: "http://127.0.0.1:3642", tokenEnv: "ZHIYU_MEMORY_TOKEN",
      expectedNamespace: namespace, mode: "standard", timeoutMs: 120000,
    });
    console.log(JSON.stringify({ initialized: true, container, databasePort: 5433,
      serviceUrl: "http://127.0.0.1:3642", namespace, skillProfile: profileFile,
      credentials, secretsLogged: false }));
  } finally { await sql.end({ timeout: 5 }); }
}
main().catch(() => {
  console.error(JSON.stringify({ code: "local_memory_setup_failed", privateConfiguration: serviceFile }));
  process.exitCode = 1;
});
