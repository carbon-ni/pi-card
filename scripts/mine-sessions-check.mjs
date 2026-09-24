import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const script = path.join(import.meta.dirname, "../skills/pi-card-callibration/scripts/mine-sessions.mjs");
const date = "2026-09-20";
const project = "/workspace/pi-card";

function message(role, text) {
  return JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-card-callibration-test-"));
  const sessions = path.join(root, "sessions");
  await mkdir(sessions);
  return { root, sessions, output: path.join(root, "candidates.json") };
}

async function writeSession(directory, filename, { cwd = project, timestamp = `${date}T12:00:00.000Z`, rows = [] } = {}) {
  const content = [JSON.stringify({ type: "session", cwd, timestamp }), ...rows].join("\n") + "\n";
  await writeFile(path.join(directory, filename), content);
}

function runMiner({ sessions, output, root: _fixtureRoot, ...args }) {
  const options = [
    "--sessions", sessions,
    "--project", project,
    "--since", date,
    "--until", date,
    "--output", output,
    ...Object.entries(args).flatMap(([key, value]) => [`--${key}`, String(value)]),
  ];
  return execFile(process.execPath, [script, ...options]);
}

test("requires explicit consent and writes nothing when consent is absent", async () => {
  const f = await fixture();
  try {
    await writeSession(f.sessions, "session.jsonl", { rows: [message("user", "private message")] });
    await assert.rejects(runMiner({ ...f }), /Explicit consent is required/);
    await assert.rejects(readFile(f.output), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("mines only matching project/date user messages with redaction and short context", async () => {
  const f = await fixture();
  try {
    await writeSession(f.sessions, "match.jsonl", {
      rows: [
        message("user", "older request"),
        message("assistant", "brief previous context"),
        message("user", "Stop and retry. Contact me at test.person@example.com. key-12345678901234567890"),
        message("assistant", "not a candidate"),
      ],
    });
    await writeSession(f.sessions, "other-project.jsonl", { cwd: "/workspace/other", rows: [message("user", "out of scope")] });
    await writeSession(f.sessions, "other-date.jsonl", { timestamp: "2026-09-21T12:00:00Z", rows: [message("user", "out of range")] });

    await runMiner({ ...f, consent: "yes", files: 5, limit: 20 });
    const result = JSON.parse(await readFile(f.output, "utf8"));
    assert.equal(result.project, project);
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

test("caps file and candidate counts and refuses to overwrite output", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 6; i++) {
      const dir = path.join(f.sessions, `thread-${i}`);
      await mkdir(dir);
      await writeSession(dir, `session-${i}.jsonl`, { timestamp: `${date}T${String(i).padStart(2, "0")}:00:00Z`, rows: [message("user", `candidate ${i}`)] });
    }
    await runMiner({ ...f, consent: "yes", files: 5, limit: 2 });
    const first = await readFile(f.output, "utf8");
    const result = JSON.parse(first);
    assert.equal(result.selectedSessionFiles, 5);
    assert.equal(result.candidates.length, 2);
    await assert.rejects(runMiner({ ...f, consent: "yes", files: 5, limit: 2 }));
    assert.equal(await readFile(f.output, "utf8"), first);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("ignores symlinks and fails closed on malformed matching session data", async () => {
  const f = await fixture();
  try {
    const external = path.join(f.root, "external.jsonl");
    await writeSession(f.root, "external.jsonl", { rows: [message("user", "external")] });
    await symlink(external, path.join(f.sessions, "linked.jsonl"));
    await runMiner({ ...f, consent: "yes" });
    assert.equal(JSON.parse(await readFile(f.output, "utf8")).selectedSessionFiles, 0);

    await rm(f.output);
    await writeFile(path.join(f.sessions, "broken.jsonl"), `${JSON.stringify({ type: "session", cwd: project, timestamp: `${date}T12:00:00Z` })}\n{bad json}\n`);
    await assert.rejects(runMiner({ ...f, consent: "yes" }), /Malformed selected session JSONL/);
    await assert.rejects(readFile(f.output), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects unbounded and reversed date/file ranges", async () => {
  const f = await fixture();
  try {
    await assert.rejects(runMiner({ ...f, consent: "yes", files: 6 }), /--files must be between/);
    const args = ["--consent", "yes", "--sessions", f.sessions, "--project", project, "--since", "2026-09-21", "--until", date, "--output", f.output];
    await assert.rejects(execFile(process.execPath, [script, ...args]), /--since must be on or before/);
    await assert.rejects(readFile(f.output), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
