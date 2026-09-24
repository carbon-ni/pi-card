import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temp = await mkdtemp(path.join(os.tmpdir(), "pi-card-package-"));
const allowed = (file) =>
  file === "package.json" || file === "README.md" || file === "LICENSE" || file.startsWith("src/") || file.startsWith("docs/") || file.startsWith("skills/");

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
  if (!packageJson.pi?.skills?.includes("./skills")) {
    throw new Error("Package manifest does not declare the packaged Pi skills directory");
  }
  const packedFiles = (await execFile("tar", ["-tzf", tarball])).stdout
    .split("\n")
    .filter(Boolean)
    .map((file) => file.replace(/^package\//, "").replace(/\/$/, ""));
  const unexpected = packedFiles.find((file) => !allowed(file));
  if (unexpected) throw new Error(`Unexpected packed file: ${unexpected}`);
  for (const required of ["package.json", "README.md", "LICENSE", "src/index.ts", "src/intervention-evidence.ts", "src/router.ts", "docs/configuration.md", "skills/pi-card-callibration/SKILL.md", "skills/pi-card-callibration/scripts/mine-sessions.mjs"]) {
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
  if (consumerManifest.license !== "MIT") throw new Error("Installed package must declare the MIT license");
  if (consumerManifest.pi?.extensions?.[0] !== "./src/index.ts") {
    throw new Error("Installed package does not declare the expected Pi extension entrypoint");
  }
  await readFile(path.join(installed, "src/index.ts"), "utf8");
  await execFile("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
    "--legacy-peer-deps", "@earendil-works/pi-coding-agent@0.82.0",
  ], { cwd: consumer });
  const agentDir = path.join(temp, "agent-config");
  await mkdir(agentDir);
  const smoke = path.join(consumer, "verify-extension-load.mjs");
  await writeFile(smoke, `
    import path from "node:path";
    import { readFile } from "node:fs/promises";
    import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
    const packageRoot = path.resolve(process.env.PI_CARD_PACKAGE_ROOT);
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    const extensionPaths = manifest.pi.extensions.map((resource) => path.resolve(packageRoot, resource));
    const skillPaths = manifest.pi.skills.map((resource) => path.resolve(packageRoot, resource));
    const extensionPath = path.resolve(process.env.PI_CARD_EXTENSION);
    if (!extensionPaths.includes(extensionPath)) throw new Error("Smoke extension path is not declared in the installed package manifest");
    const skillPath = path.join(packageRoot, "skills");
    if (!skillPaths.includes(skillPath)) throw new Error("Installed manifest skill path does not resolve to packaged skills");
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.env.PI_CARD_AGENT_DIR,
      additionalExtensionPaths: extensionPaths,
      additionalSkillPaths: skillPaths,
      noSkills: false,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload({ resolveProjectTrust: async () => true });
    const result = loader.getExtensions();
    if (result.errors.length) throw new Error(JSON.stringify(result.errors));
    const loaded = result.extensions.find((extension) => extension.resolvedPath === extensionPath);
    if (!loaded?.handlers.has("input") || !loaded.handlers.has("message_start") || !loaded.handlers.has("agent_settled")) {
      throw new Error("Pi host did not load Pi Card's registered input and evidence hooks");
    }
    const skills = loader.getSkills();
    if (skills.diagnostics.length) throw new Error(JSON.stringify(skills.diagnostics));
    if (!skills.skills.some((skill) => skill.name === "pi-card-callibration")) {
      throw new Error("Pi host did not discover the packaged pi-card-callibration skill");
    }
  `);
  await execFile(process.execPath, [smoke], {
    cwd: consumer,
    env: {
      ...process.env,
      PI_CARD_EXTENSION: path.join(installed, "src/index.ts"),
      PI_CARD_PACKAGE_ROOT: installed,
      PI_CARD_AGENT_DIR: agentDir,
    },
  });

  console.log(`Package verification passed: ${packageJson.name}@${packageJson.version} (${packedFiles.length} files, Pi extension hooks and calibration skill loaded)`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
