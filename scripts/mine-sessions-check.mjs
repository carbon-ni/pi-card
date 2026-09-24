import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const script = path.join(import.meta.dirname, "../skills/pi-card-callibration/scripts/mine-sessions.mjs");
const date = "2026-09-20";

function message(role, text) {
  return JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
}

async function fixture(prefix = "pi-card-callibration-test-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const sessions = path.join(root, "sessions");
  const project = path.join(root, "project");
  await mkdir(sessions);
  await mkdir(project);
  return { root, agentDir: root, sessions, project, output: "candidates.json" };
}

async function writeSession(directory, filename, { cwd, timestamp = `${date}T12:00:00.000Z`, rows = [] } = {}) {
  const content = [JSON.stringify({ type: "session", cwd, timestamp }), ...rows].join("\n") + "\n";
  await writeFile(path.join(directory, filename), content);
}

function runMiner({ agentDir, project, output, root: _fixtureRoot, sessions: _fixtureSessions, ...args }) {
  const options = [
    "--project", project,
    "--since", date,
    "--until", date,
    "--output", output,
    ...Object.entries(args).flatMap(([key, value]) => [`--${key}`, String(value)]),
  ];
  return execFile(process.execPath, [script, ...options], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
}

async function outputFile(f) {
  return path.join(f.agentDir, f.output);
}

test("requires explicit consent and writes nothing when consent is absent", async () => {
  const f = await fixture();
  try {
    await writeSession(f.sessions, "session.jsonl", { cwd: f.project, rows: [message("user", "private message")] });
    await assert.rejects(runMiner({ ...f }), /Explicit consent is required/);
    await assert.rejects(readFile(await outputFile(f)), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("mines only matching project/date user messages with redaction and short context", async () => {
  const f = await fixture();
  try {
    await writeSession(f.sessions, "match.jsonl", {
      cwd: f.project,
      rows: [
        message("user", "older request"),
        message("assistant", "brief previous context"),
        message("user", "Stop and retry. Contact me at test.person@example.com. key-12345678901234567890"),
        message("assistant", "not a candidate"),
      ],
    });
    await writeSession(f.sessions, "other-project.jsonl", { cwd: "/workspace/other", rows: [message("user", "out of scope")] });
    await writeSession(f.sessions, "other-date.jsonl", { cwd: f.project, timestamp: "2026-09-21T12:00:00Z", rows: [message("user", "out of range")] });

    await runMiner({ ...f, consent: "yes", files: 5, limit: 20 });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.equal(result.project, await realpath(f.project));
    assert.deepEqual(result.dateRange, { since: date, until: date });
    assert.equal(result.selectedSessionFiles, 1);
    assert.equal(result.candidates.length, 2);
    assert.match(result.candidates[0].text, /\[REDACTED_EMAIL\]/);
    assert.match(result.candidates[0].text, /\[REDACTED_SECRET\]/);
    assert.equal(result.candidates[0].context, "brief previous context");
    assert.equal(result.candidates[1].text, "older request");
    assert.equal(result.candidates[0].label, null);
    assert.equal(result.candidates[0].activeStatus, "unknown");
    assert.doesNotMatch(JSON.stringify(result), /out of scope|out of range|not a candidate/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("uses only the configured agent's sessions root and supports a custom agent directory", async () => {
  const f = await fixture("pi-card-custom-agent-");
  const defaultSessions = path.join(f.root, "outside-sessions");
  try {
    await mkdir(defaultSessions);
    await writeSession(f.sessions, "custom.jsonl", { cwd: f.project, rows: [message("user", "from custom config")] });
    await writeSession(defaultSessions, "outside.jsonl", { cwd: f.project, rows: [message("user", "out of scope")] });
    await runMiner({ ...f, consent: "yes" });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(result.candidates.map(({ text }) => text), ["from custom config"]);

    const env = { ...process.env, PI_CODING_AGENT_DIR: f.agentDir };
    await assert.rejects(execFile(process.execPath, [script, "--consent", "yes", "--sessions", defaultSessions, "--project", f.project, "--since", date, "--until", date, "--output", "other.json"], { env }), /Unknown option: --sessions/);
    await assert.rejects(readFile(path.join(defaultSessions, "other.json")), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("caps file and candidate counts and refuses to overwrite output", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 6; i++) {
      const dir = path.join(f.sessions, `thread-${i}`);
      await mkdir(dir);
      await writeSession(dir, `session-${i}.jsonl`, { cwd: f.project, timestamp: `${date}T${String(i).padStart(2, "0")}:00:00Z`, rows: [message("user", `candidate ${i}`)] });
    }
    await runMiner({ ...f, consent: "yes", files: 5, limit: 2 });
    const file = await outputFile(f);
    const first = await readFile(file, "utf8");
    const result = JSON.parse(first);
    assert.equal(result.selectedSessionFiles, 5);
    assert.equal(result.candidates.length, 2);
    await assert.rejects(runMiner({ ...f, consent: "yes", files: 5, limit: 2 }));
    assert.equal(await readFile(file, "utf8"), first);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("ignores symlinks and fails closed on malformed matching session data", async () => {
  const f = await fixture();
  try {
    const external = path.join(f.root, "external.jsonl");
    await writeSession(f.root, "external.jsonl", { cwd: f.project, rows: [message("user", "external")] });
    await symlink(external, path.join(f.sessions, "linked.jsonl"));
    await runMiner({ ...f, consent: "yes" });
    assert.equal(JSON.parse(await readFile(await outputFile(f), "utf8")).selectedSessionFiles, 0);

    await rm(await outputFile(f));
    await writeFile(path.join(f.sessions, "broken.jsonl"), `${JSON.stringify({ type: "session", cwd: f.project, timestamp: `${date}T12:00:00Z` })}\n{bad json}\n`);
    await assert.rejects(runMiner({ ...f, consent: "yes" }), /Malformed selected session JSONL/);
    await assert.rejects(readFile(await outputFile(f)), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects symlinked session roots, unbounded paths, and reversed ranges", async () => {
  const f = await fixture();
  try {
    const outsideSessions = path.join(f.root, "outside-sessions");
    await mkdir(outsideSessions);
    await rm(f.sessions, { recursive: true });
    await symlink(outsideSessions, f.sessions);
    const env = { ...process.env, PI_CODING_AGENT_DIR: f.root };
    await assert.rejects(execFile(process.execPath, [script, "--consent", "yes", "--project", f.project, "--since", date, "--until", date, "--output", f.output], { env }), /Pi sessions directory must be a real directory/);
    await assert.rejects(runMiner({ ...f, consent: "yes", output: "../outside.json" }), /Usage: mine-sessions/);
    await assert.rejects(runMiner({ ...f, consent: "yes", files: 6 }), /--files must be between/);
    const args = ["--consent", "yes", "--project", f.project, "--since", "2026-09-21", "--until", date, "--output", "reverse.json"];
    await assert.rejects(execFile(process.execPath, [script, ...args], { env }), /--since must be on or before/);
    await assert.rejects(readFile(await outputFile(f)), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("canonicalizes the requested project path before matching session metadata", async () => {
  const f = await fixture();
  const alias = `${f.project}-alias`;
  try {
    await symlink(f.project, alias);
    await writeSession(f.sessions, "canonical.jsonl", { cwd: f.project, rows: [message("user", "canonical project match")] });
    await runMiner({ ...f, project: alias, consent: "yes" });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.equal(result.project, await realpath(f.project));
    assert.deepEqual(result.candidates.map(({ text }) => text), ["canonical project match"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
