import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import type {Identity} from "../../packages/memory/src/ports";
import {createKnowledgeHost} from "../../packages/memory/src/knowledge";
import {createPostgresKnowledgeStore} from "../../packages/memory-postgres/src/knowledge";
import {fail} from "../../packages/memory/src/validation";

/** Operator-owned allowlist. No namespace, module or config is selected by request JSON. */
export async function loadStandardProjects(file: string | undefined, ports: any) {
  const projects = new Map<string, any>();
  if (file) {
    const entries = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(entries)) throw Error("standard_projects_registry_invalid");
    for (const entry of entries) {
      if (!entry.namespace?.tenantId || !entry.namespace?.projectId || !path.isAbsolute(entry.modulePath)) throw Error("standard_project_invalid");
      const key = JSON.stringify([entry.namespace.tenantId, entry.namespace.projectId]);
      if (projects.has(key)) throw Error("duplicate_standard_project");
      const module = await import(pathToFileURL(entry.modulePath).href);
      if (typeof module.createStandardProject !== "function") throw Error("standard_project_factory_required");
      projects.set(key, await module.createStandardProject({...ports, createKnowledgeHost, createPostgresKnowledgeStore, fail}, entry));
    }
  }
  return (identity: Identity) => projects.get(JSON.stringify([identity.namespace.tenantId, identity.namespace.projectId]));
}
