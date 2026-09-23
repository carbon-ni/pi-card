import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temp = await mkdtemp(path.join(os.tmpdir(), "pi-card-package-"));
const allowed = (file) =>
  file === "package.json" || file === "README.md" || file.startsWith("src/") || file.startsWith("docs/");

try {
  const requestedTarball = process.argv[2];
  let tarball = requestedTarball;
  if (!tarball) {
    const packed = await execFile("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root });
    tarball = path.join(temp, JSON.parse(packed.stdout)[0].filename);
  } else {
    tarball = path.resolve(tarball);
  }

  const pack = await execFile("npm", ["pack", "--dry-run", "--json"], { cwd: root });
  const manifest = JSON.parse(pack.stdout)[0];
  if (manifest.name !== packageJson.name || manifest.version !== packageJson.version) {
    throw new Error("Packed package identity does not match package.json");
  }
  const files = manifest.files.map(({ path: file }) => file);
  const packedFiles = (await execFile("tar", ["-tzf", tarball])).stdout
    .split("\n")
    .filter(Boolean)
    .map((file) => file.replace(/^package\//, "").replace(/\/$/, ""));
  const unexpected = packedFiles.find((file) => !allowed(file));
  if (unexpected) throw new Error(`Unexpected packed file: ${unexpected}`);
  for (const required of ["package.json", "README.md", "src/index.ts", "src/router.ts", "docs/configuration.md"]) {
    if (!packedFiles.includes(required)) throw new Error(`Required packed file missing: ${required}`);
  }
  if (packedFiles.some((file) => /(^|\/)(\.pi|\.tmp|tests?|node_modules)(\/|$)/i.test(file) || /\.(test|spec)\.[cm]?tsx?$/.test(file))) {
    throw new Error("Private config, tests, or dependencies leaked into the package");
  }

  const consumer = path.join(temp, "consumer");
  await mkdir(consumer);
  await execFile("npm", ["init", "--yes"], { cwd: consumer });
  await execFile("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--legacy-peer-deps", tarball], { cwd: consumer });
  const installed = path.join(consumer, "node_modules", packageJson.name);
  const consumerManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  if (consumerManifest.pi?.extensions?.[0] !== "./src/index.ts") {
    throw new Error("Installed package does not declare the expected Pi extension entrypoint");
  }
  await readFile(path.join(installed, "src/index.ts"), "utf8");
  await execFile("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
    "--legacy-peer-deps", "@earendil-works/pi-coding-agent@0.82.0",
  ], { cwd: consumer });
  const pi = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  await execFile(pi, ["--no-extensions", "--extension", path.join(installed, "src/index.ts"), "--help"], {
    cwd: consumer,
    env: { ...process.env, PI_OFFLINE: "1" },
  });

  console.log(`Package verification passed: ${packageJson.name}@${packageJson.version} (${packedFiles.length} files, Pi host load)`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
