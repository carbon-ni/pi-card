import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");

test("package verification rejects a tarball missing the extension entrypoint", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-card-package-test-"));
  try {
    const packed = await execFile("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root });
    const filename = JSON.parse(packed.stdout)[0].filename;
    const unpacked = path.join(temp, "unpacked");
    await execFile("mkdir", [unpacked]);
    await execFile("tar", ["-xzf", path.join(temp, filename), "-C", unpacked]);
    await rm(path.join(unpacked, "package", "src", "index.ts"));
    const broken = path.join(temp, "broken.tgz");
    await execFile("tar", ["-czf", broken, "package"], { cwd: unpacked });

    await assert.rejects(
      execFile(process.execPath, ["scripts/verify-package.mjs", broken], { cwd: root }),
      (error) => `${error.stderr}\n${error.message}`.includes("Required packed file missing: src/index.ts"),
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
