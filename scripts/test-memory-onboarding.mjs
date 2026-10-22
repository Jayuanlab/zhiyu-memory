import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repository, "skills/zhiyu-memory-onboarding");
const decoder = new TextDecoder("utf-8", { fatal: true });

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `A portable skill must not rely on a symlink: ${file}`);
    return entry.isDirectory() ? files(file) : [file];
  });
}

test("the onboarding skill works as a standalone directory with readable local resources", t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-onboarding-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const copy = path.join(temporary, "zhiyu-memory-onboarding");
  for (const file of files(source)) {
    const destination = path.join(copy, path.relative(source, file));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
  }
  const copied = files(copy);
  assert.ok(copied.length > 2);
  for (const file of copied) {
    const relative = path.relative(copy, file);
    assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(source, relative)));
    const text = decoder.decode(fs.readFileSync(file));
    assert.ok(!text.includes("\uFFFD"), `Invalid text in ${relative}`);
    if (!file.endsWith(".md")) continue;
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1];
      if (/^(?:https?:|mailto:|#)/.test(link)) continue;
      const resource = path.resolve(path.dirname(file), link.split("#")[0]);
      const fromRoot = path.relative(copy, resource);
      assert.ok(fromRoot && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot),
        `${relative} refers outside its installed directory: ${link}`);
      assert.ok(fs.statSync(resource).isFile(), `Missing linked resource: ${link}`);
    }
  }
  assert.ok(fs.statSync(path.join(copy, "LICENSE")).isFile());
});
