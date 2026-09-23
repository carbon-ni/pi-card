import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MISSING_NPM_CODES = new Set(["E404", "ETARGET"]);

export function releaseTagMatchesVersion(tag, version) {
  return tag === `v${version}`;
}

function isMissingNpmArtifactError(error) {
  const output = typeof error?.stdout === "string" ? error.stdout.trim() : "";
  if (output) {
    try {
      return MISSING_NPM_CODES.has(JSON.parse(output)?.error?.code);
    } catch {
      return false;
    }
  }
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  return MISSING_NPM_CODES.has(
    stderr.match(/(?:^|\n)\s*npm\s+(?:error|ERR!)\s+code\s+(E404|ETARGET)\b/im)?.[1]?.toUpperCase(),
  );
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function existingAsset(tag, filename, directory, run) {
  const result = await run("gh", ["release", "view", tag, "--json", "assets"]);
  const assets = JSON.parse(result.stdout).assets ?? [];
  if (!assets.some((asset) => asset.name === filename)) return null;
  await run("gh", ["release", "download", tag, "--pattern", filename, "--dir", directory]);
  return path.join(directory, filename);
}

/** Attach or verify the canonical tarball and checksum. Existing bytes must match. */
export async function attachReleaseAssets({ tarball, releaseTag, version, run = execFile }) {
  if (!releaseTagMatchesVersion(releaseTag, version)) {
    throw new Error(`Release tag ${releaseTag} does not match package version ${version}`);
  }
  const checksum = path.join(path.dirname(tarball), "SHA256SUMS");
  const work = await mkdtemp(path.join(tmpdir(), "pi-card-release-assets-"));
  try {
    const decisions = {};
    for (const file of [tarball, checksum]) {
      const name = path.basename(file);
      const existing = await existingAsset(releaseTag, name, work, run);
      if (!existing) {
        await run("gh", ["release", "upload", releaseTag, file]);
        decisions[name] = "uploaded";
      } else if ((await sha256(existing)) === (await sha256(file))) {
        decisions[name] = "identical";
      } else {
        throw new Error(`GitHub Release ${releaseTag} has different bytes for ${name}`);
      }
    }
    return decisions;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Publish the same verified tarball to npm and resume only matching existing artifacts. */
export async function publishRelease({ tarball, packageName, version, releaseTag, npmTag, run = execFile }) {
  if (process.env.QUALITY_GATE_RESULT !== "success") {
    throw new Error("Quality gate did not authorize publication");
  }
  if (!releaseTagMatchesVersion(releaseTag, version)) {
    throw new Error(`Release tag ${releaseTag} does not match package version ${version}`);
  }

  const localHash = await sha256(tarball);
  const work = await mkdtemp(path.join(tmpdir(), "pi-card-npm-check-"));
  try {
    let existing = null;
    try {
      const packed = await run("npm", [
        "pack", `${packageName}@${version}`, "--ignore-scripts", "--json", "--pack-destination", work,
      ]);
      existing = path.join(work, JSON.parse(packed.stdout)[0].filename);
    } catch (error) {
      if (!isMissingNpmArtifactError(error)) throw error;
    }

    let npmDecision = "published";
    if (existing) {
      if ((await sha256(existing)) !== localHash) {
        throw new Error(`npm ${packageName}@${version} exists with different artifact bytes`);
      }
      npmDecision = "identical";
    } else {
      await run("npm", ["publish", tarball, "--access", "public", "--tag", npmTag]);
    }

    const github = await attachReleaseAssets({ tarball, releaseTag, version, run });
    return { npm: npmDecision, github, sha256: localHash };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const githubOnly = process.argv[2] === "--github-assets-only";
  const tarball = process.argv[githubOnly ? 3 : 2];
  if (!tarball) throw new Error("Usage: node scripts/release-publish.mjs [--github-assets-only] <tarball>");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  let result;
  if (githubOnly) {
    result = await attachReleaseAssets({
      tarball,
      releaseTag: process.env.RELEASE_TAG,
      version: packageJson.version,
    });
  } else {
    result = await publishRelease({
      tarball,
      packageName: packageJson.name,
      version: packageJson.version,
      releaseTag: process.env.RELEASE_TAG,
      npmTag: process.env.NPM_TAG ?? (process.env.RELEASE_PRERELEASE === "true" ? "next" : "latest"),
    });
  }
  console.log(JSON.stringify(result));
}
