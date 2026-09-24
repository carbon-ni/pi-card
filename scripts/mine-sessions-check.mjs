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

function message(role, text, timestamp = `${date}T12:00:00.000Z`, stringContent = false, id, parentId) {
  const message = { role, content: stringContent ? text : [{ type: "text", text }] };
  const parsed = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  const row = { type: "message", message };
  if (timestamp !== null) row.timestamp = Number.isFinite(parsed) ? parsed : timestamp;
  if (id) row.id = id;
  if (parentId) row.parentId = parentId;
  return JSON.stringify(row);
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
        message("user", "out-of-range old request", "2026-09-19T23:59:59.999Z", false, "u0"),
        message("assistant", "out-of-range context", "2026-09-19T23:59:59.999Z", false, "a0", "u0"),
        message("user", "older request", "2026-09-20T00:00:00.000Z", true, "u1", "a0"),
        message("assistant", "brief previous context", `${date}T12:00:00.000Z`, false, "a1", "u1"),
        message("user", "Stop and retry. Contact me at test.person@example.com. key-12345678901234567890", `${date}T12:00:00.000Z`, false, "u2", "a1"),
        message("assistant", "not a candidate", "2026-09-21T00:00:00.000Z", false, "a2", "u2"),
        message("user", "missing timestamp", null, false, "u3", "a2"),
        message("assistant", "invalid timestamp", "invalid", false, "a3", "u3"),
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
    assert.doesNotMatch(JSON.stringify(result), /out of scope|out of range|not a candidate|missing timestamp|invalid timestamp/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("supports Pi's documented top-level timestamps and string user content", async () => {
  const f = await fixture();
  try {
    const row = {
      type: "message",
      timestamp: Date.parse(`${date}T08:15:00.000Z`),
      message: { role: "user", content: "Please steer toward the simpler solution." },
    };
    await writeFile(path.join(f.sessions, "documented-format.jsonl"), [
      JSON.stringify({ type: "session", cwd: f.project, timestamp: `${date}T08:00:00.000Z` }),
      JSON.stringify(row),
    ].join("\n") + "\n");
    await runMiner({ ...f, consent: "yes" });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(result.candidates.map(({ text }) => text), [row.message.content]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("uses the nearest in-range ancestor, not the adjacent message from an abandoned branch", async () => {
  const f = await fixture();
  try {
    await writeSession(f.sessions, "branched.jsonl", {
      cwd: f.project,
      rows: [
        message("user", "root request", undefined, false, "root"),
        message("assistant", "shared context", undefined, false, "shared", "root"),
        message("assistant", "correct branch context", undefined, false, "good", "shared"),
        message("user", "abandoned branch request", undefined, false, "other-user", "shared"),
        message("assistant", "misleading adjacent context", undefined, false, "other-assistant", "other-user"),
        message("user", "current calibration candidate", undefined, false, "current", "good"),
      ],
    });
    await runMiner({ ...f, consent: "yes" });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    const current = result.candidates.find(({ text }) => text === "current calibration candidate");
    assert.equal(current.context, "correct branch context");
    assert.doesNotMatch(JSON.stringify(current), /misleading adjacent context/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("leaves context empty for missing or cyclic parent chains", async () => {
  const f = await fixture();
  try {
    await writeSession(f.sessions, "cycles.jsonl", {
      cwd: f.project,
      rows: [
        message("toolResult", "cycle one", undefined, false, "cycle-one", "cycle-two"),
        message("toolResult", "cycle two", undefined, false, "cycle-two", "cycle-one"),
        message("user", "cyclic parent candidate", undefined, false, "cyclic", "cycle-one"),
        message("user", "missing parent candidate", undefined, false, "missing", "not-present"),
      ],
    });
    await runMiner({ ...f, consent: "yes" });
    const { candidates } = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.equal(candidates.find(({ text }) => text === "cyclic parent candidate").context, "");
    assert.equal(candidates.find(({ text }) => text === "missing parent candidate").context, "");
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
