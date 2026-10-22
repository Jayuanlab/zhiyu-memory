#!/usr/bin/env node
// Inject the current checkout's private identity without exposing its token to the model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const reviewer = args[0] === "--reviewer";
if (reviewer) args.shift();
try {
  if (!args.length) throw Error("local_memory_command_required");
  const directory = path.join(root, "private/local-memory");
  const profileFile = path.join(directory, "skill-profile.json");
  const profile = JSON.parse(fs.readFileSync(profileFile, "utf8"));
  const credential = JSON.parse(fs.readFileSync(path.join(directory,
    reviewer ? "reviewer-credential.json" : "agent-credential.json"), "utf8"));
  if (!credential.token || Date.parse(credential.expiresAt) <= Date.now())
    throw Error("local_identity_expired_or_missing");
  const skill = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    "skills/zhiyu-memory/scripts/memory-client.mjs");
  const child = spawn(process.execPath, [skill, "--config", profileFile, ...args], {
    cwd: root, windowsHide: true, stdio: "inherit",
    env: { ...process.env, [profile.tokenEnv]: credential.token },
  });
  child.on("error", () => { console.error('{"code":"local_skill_launch_failed"}'); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} catch (error) {
  const safe = ["local_memory_command_required", "local_identity_expired_or_missing"];
  console.error(JSON.stringify({ code: safe.includes(error.message) ? error.message : "local_memory_configuration_unavailable" }));
  process.exitCode = 1;
}
