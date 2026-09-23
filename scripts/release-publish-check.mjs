import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attachReleaseAssets, publishRelease } from "./release-publish.mjs";

async function fixture(bytes = "canonical-tarball") {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-card-release-test-"));
  const tarball = path.join(root, "carbon-ni-pi-card-0.1.0.tgz");
  await writeFile(tarball, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(root, "SHA256SUMS"), `${digest}  ${path.basename(tarball)}\n`);
  return { root, tarball, checksum: path.join(root, "SHA256SUMS") };
}

function githubRun(files = new Map()) {
  const uploads = [];
  const run = async (command, args) => {
    if (command !== "gh") throw new Error(`Unexpected command: ${command}`);
    if (args[1] === "view") {
      return { stdout: JSON.stringify({ assets: [...files.keys()].map((name) => ({ name })) }) };
    }
    if (args[1] === "download") {
      const name = args[args.indexOf("--pattern") + 1];
      const dir = args[args.indexOf("--dir") + 1];
      await writeFile(path.join(dir, name), files.get(name));
      return { stdout: "" };
    }
    if (args[1] === "upload") {
      const file = args[3];
      const name = path.basename(file);
      files.set(name, await readFile(file));
      uploads.push(name);
      return { stdout: "" };
    }
    throw new Error(`Unexpected gh args: ${args.join(" ")}`);
  };
  return { run, files, uploads };
}

test("GitHub-only release job attaches tarball and checksum", async () => {
  const { root, tarball, checksum } = await fixture();
  const github = githubRun();
  try {
    const result = await attachReleaseAssets({ tarball, releaseTag: "v0.1.0", version: "0.1.0", run: github.run });
    assert.deepEqual(github.uploads, [path.basename(tarball), "SHA256SUMS"]);
    assert.equal(result["SHA256SUMS"], "uploaded");
    assert.equal((await readFile(path.join(root, "SHA256SUMS"), "utf8")), (await readFile(checksum, "utf8")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identical GitHub assets are verified and not uploaded again", async () => {
  const { root, tarball, checksum } = await fixture();
  const github = githubRun(new Map([
    [path.basename(tarball), await readFile(tarball)],
    ["SHA256SUMS", await readFile(checksum)],
  ]));
  try {
    const result = await attachReleaseAssets({ tarball, releaseTag: "v0.1.0", version: "0.1.0", run: github.run });
    assert.equal(result[path.basename(tarball)], "identical");
    assert.deepEqual(github.uploads, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mismatched existing GitHub asset fails without overwriting", async () => {
  const { root, tarball, checksum } = await fixture();
  const github = githubRun(new Map([[path.basename(tarball), Buffer.from("different bytes")]]));
  try {
    await assert.rejects(
      attachReleaseAssets({ tarball, releaseTag: "v0.1.0", version: "0.1.0", run: github.run }),
      /different bytes/,
    );
    assert.deepEqual(github.uploads, []);
    await readFile(checksum);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("npm publication resumes identical versions and attaches missing release assets", async () => {
  const { root, tarball, checksum } = await fixture();
  const github = githubRun();
  const previous = process.env.QUALITY_GATE_RESULT;
  process.env.QUALITY_GATE_RESULT = "success";
  const calls = [];
  try {
    const run = async (command, args) => {
      calls.push([command, args]);
      if (command === "npm" && args[0] === "pack") {
        const error = new Error("not published");
        error.stdout = JSON.stringify({ error: { code: "E404" } });
        throw error;
      }
      if (command === "npm" && args[0] === "publish") return { stdout: "" };
      return github.run(command, args);
    };
    const result = await publishRelease({
      tarball, packageName: "@carbon-ni/pi-card", version: "0.1.0", releaseTag: "v0.1.0", npmTag: "latest", run,
    });
    assert.equal(result.npm, "published");
    assert.deepEqual(github.uploads, [path.basename(tarball), "SHA256SUMS"]);
    assert.ok(calls.some(([command, args]) => command === "npm" && args[0] === "publish"));
    await readFile(checksum);
  } finally {
    if (previous === undefined) delete process.env.QUALITY_GATE_RESULT;
    else process.env.QUALITY_GATE_RESULT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("identical npm publication and release assets resume without re-upload", async () => {
  const { root, tarball, checksum } = await fixture();
  const assets = new Map([
    [path.basename(tarball), await readFile(tarball)],
    ["SHA256SUMS", await readFile(checksum)],
  ]);
  const github = githubRun(assets);
  const previous = process.env.QUALITY_GATE_RESULT;
  process.env.QUALITY_GATE_RESULT = "success";
  const calls = [];
  try {
    const run = async (command, args) => {
      calls.push([command, args]);
      if (command === "npm" && args[0] === "pack") {
        const destination = args.at(-1);
        await writeFile(path.join(destination, path.basename(tarball)), await readFile(tarball));
        return { stdout: JSON.stringify([{ filename: path.basename(tarball) }]) };
      }
      return github.run(command, args);
    };
    const result = await publishRelease({
      tarball, packageName: "@carbon-ni/pi-card", version: "0.1.0", releaseTag: "v0.1.0", npmTag: "latest", run,
    });
    assert.equal(result.npm, "identical");
    assert.equal(calls.some(([command, args]) => command === "npm" && args[0] === "publish"), false);
    assert.deepEqual(github.uploads, []);
  } finally {
    if (previous === undefined) delete process.env.QUALITY_GATE_RESULT;
    else process.env.QUALITY_GATE_RESULT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("npm artifact mismatch fails closed before publish", async () => {
  const { root, tarball } = await fixture();
  const previous = process.env.QUALITY_GATE_RESULT;
  process.env.QUALITY_GATE_RESULT = "success";
  try {
    const run = async (command, args) => {
      if (command === "npm" && args[0] === "pack") {
        const destination = args.at(-1);
        await writeFile(path.join(destination, path.basename(tarball)), "different bytes");
        return { stdout: JSON.stringify([{ filename: path.basename(tarball) }]) };
      }
      throw new Error("Should not publish after mismatch");
    };
    await assert.rejects(
      publishRelease({ tarball, packageName: "@carbon-ni/pi-card", version: "0.1.0", releaseTag: "v0.1.0", npmTag: "latest", run }),
      /npm .*different artifact bytes/,
    );
  } finally {
    if (previous === undefined) delete process.env.QUALITY_GATE_RESULT;
    else process.env.QUALITY_GATE_RESULT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
