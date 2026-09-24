import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
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
  if (parentId !== undefined) row.parentId = parentId;
  return JSON.stringify(row);
}

function evidenceMarker(targetId, inputLeafEntryId, taskAnchorEntryId, id = `marker-${targetId}`, overrides = {}) {
  return JSON.stringify({
    type: "custom",
    customType: "pi-card.intervention",
    id,
    parentId: targetId,
    timestamp: `${date}T12:01:00.000Z`,
    data: {
      schemaVersion: 3,
      source: "interactive",
      activeAtInput: overrides.activeAtInput ?? true,
      streamingBehavior: "steer",
      taskAnchorEntryId,
      inputLeafEntryId,
      inputKind: overrides.inputKind ?? "jevRouted",
      observedAction: overrides.observedAction ?? "send",
      deliveryAtPersistence: overrides.deliveryAtPersistence ?? "steer",
    },
  });
}

function capturedRows(text, { prefix = "candidate", taskText = "task anchor", stringContent = false } = {}) {
  const anchorId = `${prefix}-task`;
  const leafId = `${prefix}-leaf`;
  const targetId = `${prefix}-user`;
  return [
    message("user", taskText, undefined, false, anchorId),
    message("assistant", "assistant response", undefined, false, leafId, anchorId),
    message("user", text, undefined, stringContent, targetId, leafId),
    evidenceMarker(targetId, leafId, anchorId),
  ];
}

function sessionDirectoryName(project) {
  const withoutLeadingSlash = project.startsWith("/") ? project.slice(1) : project;
  return `--${withoutLeadingSlash.replaceAll("/", "-")}--`;
}

test("matches Pi's session directory encoding", () => {
  assert.equal(sessionDirectoryName("/Users/alice/work"), "--Users-alice-work--");
});

function sessionFilename(timestamp, id = "fixture") {
  return `${new Date(timestamp).toISOString().replaceAll(":", "-").replace(".", "-")}_${id}.jsonl`;
}

async function fixture(prefix = "pi-card-callibration-test-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionsRoot = path.join(root, "sessions");
  const project = path.join(root, "project");
  await mkdir(sessionsRoot);
  await mkdir(project);
  const sessions = path.join(sessionsRoot, sessionDirectoryName(project));
  await mkdir(sessions);
  return { root, agentDir: root, sessionsRoot, sessions, project, output: "candidates.json" };
}

async function writeSession(directory, filename, { cwd, timestamp = `${date}T12:00:00.000Z`, rows = [] } = {}) {
  const file = filename.endsWith(".jsonl") && /^\d{4}-\d{2}-\d{2}T/.test(filename)
    ? filename
    : sessionFilename(timestamp, filename.replace(/\.jsonl$/, ""));
  const content = [JSON.stringify({ type: "session", cwd, timestamp }), ...rows].join("\n") + "\n";
  await writeFile(path.join(directory, file), content);
  return path.join(directory, file);
}

async function sessionReadInstrumentation(root) {
  const hook = path.join(root, "count-session-reads.mjs");
  const openLog = path.join(root, "opened-sessions.log");
  const headerReadLog = path.join(root, "header-reads.jsonl");
  await writeFile(hook, `
    import fs from "node:fs/promises";
    import { appendFileSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const originalOpen = fs.open;
    fs.open = async function (file, ...args) {
      const name = String(file);
      const handle = await originalOpen.call(this, file, ...args);
      if (!name.endsWith(".jsonl")) return handle;
      appendFileSync(process.env.PI_CARD_SESSION_OPEN_LOG, name + "\\n");
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        appendFileSync(process.env.PI_CARD_HEADER_READ_LOG, JSON.stringify({
          name, position: readArgs[3], requested: readArgs[2], bytesRead: result.bytesRead,
        }) + "\\n");
        return result;
      };
      return handle;
    };
    syncBuiltinESMExports();
  `);
  return { hook, openLog, headerReadLog };
}

function runMiner({ agentDir, project, output, env = {}, cwd = process.cwd(), root: _fixtureRoot, sessions: _fixtureSessions, sessionsRoot: _fixtureSessionsRoot, ...args }) {
  const options = [
    "--project", project,
    "--since", date,
    "--until", date,
    "--output", output,
    ...Object.entries(args).flatMap(([key, value]) => [`--${key}`, String(value)]),
  ];
  return execFile(process.execPath, [script, ...options], {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ...env },
  });
}

async function outputFile(f) {
  return path.join(f.agentDir, f.output);
}

function element(tagName = "div") {
  return {
    tagName,
    children: [],
    listeners: {},
    value: "",
    checked: false,
    append(...children) { this.children.push(...children); },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    click() { this.listeners.click?.(); },
  };
}

function descendants(root) {
  return [root, ...root.children.flatMap((child) => child.children ? descendants(child) : [])];
}

test("requires explicit consent and writes nothing when consent is absent", async () => {
  const f = await fixture();
  try {
    await writeSession(f.sessions, "session.jsonl", { cwd: f.project, rows: [message("user", "private message")] });
    await assert.rejects(runMiner({ ...f }), /Explicit consent is required/);
    await assert.rejects(readFile(await outputFile(f)), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("mines only matching marked interventions with redaction and task context", async () => {
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
        evidenceMarker("u2", "a1", "u1"),
        message("assistant", "not a candidate", "2026-09-21T00:00:00.000Z", false, "a2", "u2"),
        message("user", "missing timestamp", null, false, "u3", "a2"),
        message("assistant", "invalid timestamp", "invalid", false, "a3", "u3"),
      ],
    });
    await writeSession(f.sessions, "other-project.jsonl", { cwd: "/workspace/other", rows: [message("user", "out of scope")] });
    await writeSession(f.sessions, "other-date.jsonl", { cwd: f.project, timestamp: "2026-09-21T12:00:00Z", rows: [message("user", "out of range")] });

    await runMiner({ ...f, consent: "yes", files: 5, limit: 20 });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.equal(result.project, "[REDACTED_PATH]");
    const canonicalProject = await realpath(f.project);
    assert.notEqual(result.project, canonicalProject);
    assert.ok(!JSON.stringify(result).includes(canonicalProject));
    assert.deepEqual(result.dateRange, { since: date, until: date, timeZone: "UTC" });
    assert.equal(result.selectedSessionFiles, 1);
    assert.equal(result.candidates.length, 1);
    assert.match(result.candidates[0].text, /\[REDACTED_EMAIL\]/);
    assert.match(result.candidates[0].text, /\[REDACTED_SECRET\]/);
    assert.equal(result.candidates[0].context, "older request");
    assert.equal(result.candidates[0].label, null);
    assert.equal(result.candidates[0].activeStatus, "active");
    assert.equal(result.candidates[0].inputKind, "jevRouted");
    assert.equal(result.candidates[0].observedAction, "send");
    assert.equal(result.candidates[0].deliveryAtPersistence, "steer");
    assert.equal(result.skippedEvidenceMarkers, 0);
    assert.doesNotMatch(JSON.stringify(result), /out of scope|out of range|not a candidate|missing timestamp|invalid timestamp/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("mines idle markers through exact parent chains allowing only Pi Card diagnostics", async () => {
  const f = await fixture();
  try {
    const idleInput = { activeAtInput: false, inputKind: "interruptCard", observedAction: "transform", deliveryAtPersistence: "normal" };
    await writeSession(f.sessions, "idle-empty.jsonl", {
      cwd: f.project,
      rows: [
        message("user", "persisted transformed first input", `${date}T12:00:00.000Z`, false, "first-user", null),
        evidenceMarker("first-user", null, null, "first-marker", idleInput),
      ],
    });
    await writeSession(f.sessions, "idle-existing.jsonl", {
      cwd: f.project,
      rows: [
        message("user", "previous task", `${date}T12:00:00.000Z`, false, "previous-task", null),
        message("assistant", "idle leaf", `${date}T12:00:00.000Z`, false, "idle-leaf", "previous-task"),
        message("user", "persisted body without prefix", `${date}T12:00:00.000Z`, false, "idle-user", "idle-leaf"),
        evidenceMarker("idle-user", "idle-leaf", null, "idle-marker", {
          ...idleInput,
          inputKind: "followUpCard",
          observedAction: "transform",
        }),
      ],
    });
    await writeSession(f.sessions, "idle-debug-existing.jsonl", {
      cwd: f.project,
      rows: [
        message("user", "previous task", `${date}T12:00:00.000Z`, false, "debug-previous-task", null),
        message("assistant", "idle leaf", `${date}T12:00:00.000Z`, false, "debug-idle-leaf", "debug-previous-task"),
        JSON.stringify({ type: "custom", customType: "pi-card.routing", id: "debug-one", parentId: "debug-idle-leaf" }),
        JSON.stringify({ type: "custom", customType: "pi-card.routing", id: "debug-two", parentId: "debug-one" }),
        message("user", "persisted through debug entries", `${date}T12:00:00.000Z`, false, "debug-idle-user", "debug-two"),
        evidenceMarker("debug-idle-user", "debug-idle-leaf", null, "debug-idle-marker", idleInput),
      ],
    });
    await writeSession(f.sessions, "idle-debug-empty.jsonl", {
      cwd: f.project,
      rows: [
        JSON.stringify({ type: "custom", customType: "pi-card.routing", id: "debug-root", parentId: null }),
        message("user", "persisted through empty debug root", `${date}T12:00:00.000Z`, false, "debug-empty-user", "debug-root"),
        evidenceMarker("debug-empty-user", null, null, "debug-empty-marker", idleInput),
      ],
    });
    await writeSession(f.sessions, "idle-missing-parent.jsonl", {
      cwd: f.project,
      rows: [
        message("user", "must be excluded", `${date}T12:00:00.000Z`, false, "missing-parent-user"),
        evidenceMarker("missing-parent-user", null, null, "missing-parent-marker", idleInput),
      ],
    });

    await runMiner({ ...f, consent: "yes" });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(result.candidates.map(({ text, context, activeStatus, inputKind, observedAction }) => ({
      text, context, activeStatus, inputKind, observedAction,
    })).sort((a, b) => a.text.localeCompare(b.text)), [
      { text: "persisted body without prefix", context: "", activeStatus: "idle", inputKind: "followUpCard", observedAction: "transform" },
      { text: "persisted through debug entries", context: "", activeStatus: "idle", inputKind: "interruptCard", observedAction: "transform" },
      { text: "persisted through empty debug root", context: "", activeStatus: "idle", inputKind: "interruptCard", observedAction: "transform" },
      { text: "persisted transformed first input", context: "", activeStatus: "idle", inputKind: "interruptCard", observedAction: "transform" },
    ]);
    assert.equal(result.skippedEvidenceMarkers, 1);
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
    await writeFile(path.join(f.sessions, sessionFilename(`${date}T08:00:00.000Z`, "documented-format")), [
      JSON.stringify({ type: "session", cwd: f.project, timestamp: `${date}T08:00:00.000Z` }),
      message("user", "task anchor", undefined, false, "documented-task"),
      message("assistant", "input leaf", undefined, false, "documented-leaf", "documented-task"),
      message("user", row.message.content, row.timestamp, true, "documented-user", "documented-leaf"),
      evidenceMarker("documented-user", "documented-leaf", "documented-task"),
    ].join("\n") + "\n");
    await runMiner({ ...f, consent: "yes" });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(result.candidates.map(({ text }) => text), [row.message.content]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("creates an offline XSS-safe reviewer and exports user-selected labels", async () => {
  const f = await fixture();
  try {
    const hostileText = '</textarea><script>fetch("https://attacker.invalid")</script><img src=x onerror=alert(1)>';
    await writeSession(f.sessions, "review.jsonl", { cwd: f.project, rows: capturedRows(hostileText, { prefix: "review" }) });
    await runMiner({ ...f, consent: "yes", html: "review.html" });

    const htmlPath = path.join(f.agentDir, "review.html");
    const html = await readFile(htmlPath, "utf8");
    assert.equal((await stat(htmlPath)).mode & 0o777, 0o600);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /\[hidden\]\{display:none!important\}/);
    const appScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(appScript);
    const scriptHash = createHash("sha256").update(appScript).digest("base64");
    assert.ok(html.includes(`script-src 'sha256-${scriptHash}'`));
    assert.doesNotMatch(html, /(?:src|href)=["']https?:|XMLHttpRequest|WebSocket/);
    assert.ok(!html.includes("</textarea><script>fetch"));

    const encodedData = html.match(/<script id="candidate-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(encodedData);
    assert.ok(encodedData.includes("\\u003c"));
    const data = JSON.parse(encodedData);
    assert.equal(data.candidates[0].text, hostileText);
    assert.match(appScript, /Observed Pi behavior \(not a label\)/);

    const host = element("div");
    const summary = element("p");
    const download = element("button");
    const dataElement = element("script");
    dataElement.textContent = encodedData;
    const dom = {
      getElementById(id) { return ({ "candidate-data": dataElement, "candidate-list": host, summary, download })[id]; },
      createElement: (tag) => element(tag),
      createTextNode: (text) => ({ textContent: text }),
    };
    const blobs = [];
    const sandbox = {
      document: dom,
      Blob: class { constructor(parts, options) { this.parts = parts; this.options = options; blobs.push(this); } },
      URL: { createObjectURL: () => "blob:local-review", revokeObjectURL() {} },
      setTimeout: (callback) => callback(),
    };
    runInNewContext(appScript, sandbox);
    const controls = descendants(host);
    const select = controls.find((control) => control.tagName === "select");
    const behavior = controls.find((control) => control.tagName === "p" && control.textContent.includes("Observed Pi behavior"));
    assert.match(behavior.textContent, /active · jevRouted · action send · persisted delivery steer/);
    const stopCheckbox = controls.find((control) => control.tagName === "input");
    const stopLabel = controls.find((control) => control.tagName === "label" && control.hidden === true);
    assert.equal(stopLabel.hidden, true, "stop confirmation starts hidden");
    select.value = "steer";
    select.listeners.change();
    download.click();
    const reviewed = JSON.parse(blobs[0].parts[0]).candidates[0];
    assert.equal(reviewed.label, "steer");
    assert.equal(reviewed.inputKind, "jevRouted");
    assert.equal(reviewed.observedAction, "send");
    assert.equal(reviewed.deliveryAtPersistence, "steer");

    select.value = "stop";
    select.listeners.change();
    assert.equal(stopLabel.hidden, false, "stop confirmation appears only for stop labels");
    download.click();
    assert.equal(blobs.length, 1, "unconfirmed stop must not export");
    stopCheckbox.checked = true;
    stopCheckbox.listeners.change();
    download.click();
    const exported = JSON.parse(blobs[1].parts[0]).candidates[0];
    assert.equal(exported.label, "stop");
    assert.equal(exported.stopConfirmed, true);
    assert.equal(exported.text, hostileText);

    const [messageInput, contextInput] = controls.filter((control) => control.tagName === "textarea");
    messageInput.value = "changed after confirmation";
    messageInput.listeners.input();
    download.click();
    assert.equal(blobs.length, 2, "editing the message must revoke stop confirmation");
    stopCheckbox.checked = true;
    stopCheckbox.listeners.change();
    contextInput.value = "changed context";
    contextInput.listeners.input();
    download.click();
    assert.equal(blobs.length, 2, "editing context must revoke stop confirmation");
    await assert.rejects(runMiner({ ...f, consent: "yes", html: "review.html" }), /EEXIST/);
    assert.equal(await readFile(htmlPath, "utf8"), html);

    const candidatesBefore = await readFile(await outputFile(f), "utf8");
    await assert.rejects(runMiner({ ...f, consent: "yes", html: "orphan.html" }), /EEXIST/);
    assert.equal(await readFile(await outputFile(f), "utf8"), candidatesBefore);
    await assert.rejects(readFile(path.join(f.agentDir, "orphan.html")), { code: "ENOENT" });

    await assert.rejects(runMiner({ ...f, output: "new-candidates.json", consent: "yes", html: "review.html" }), /EEXIST/);
    await assert.rejects(readFile(path.join(f.agentDir, "new-candidates.json")), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("uses the captured task anchor, not an adjacent message from an abandoned branch", async () => {
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
        evidenceMarker("current", "good", "root"),
      ],
    });
    await runMiner({ ...f, consent: "yes" });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    const current = result.candidates.find(({ text }) => text === "current calibration candidate");
    assert.equal(current.context, "root request");
    assert.doesNotMatch(JSON.stringify(current), /misleading adjacent context/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("mines only exact markers whose frozen input and task IDs share the target branch", async () => {
  const f = await fixture();
  try {
    const extraMetadata = JSON.parse(evidenceMarker("unknown-schema", "leaf-one", "task-one"));
    extraMetadata.data.privateText = "must not be accepted";
    const outOfRangeMarker = JSON.parse(evidenceMarker("out-of-range-user", "leaf-one", "task-one"));
    outOfRangeMarker.id = "marker-out-of-range";
    outOfRangeMarker.timestamp = "2026-09-21T00:00:00.000Z";
    await writeSession(f.sessions, "evidence-contract.jsonl", {
      cwd: f.project,
      rows: [
        message("user", "task one", undefined, false, "task-one"),
        message("assistant", "input leaf one", undefined, false, "leaf-one", "task-one"),
        message("user", "valid intervention", undefined, false, "valid-user", "leaf-one"),
        evidenceMarker("valid-user", "leaf-one", "task-one"),
        message("user", "ordinary unmarked message", undefined, false, "unmarked-user", "leaf-one"),
        message("user", "wrong frozen leaf", undefined, false, "wrong-leaf-user", "leaf-one"),
        evidenceMarker("wrong-leaf-user", "absent-leaf", "task-one"),
        message("user", "intervening task", undefined, false, "intervening-user", "leaf-one"),
        message("user", "delayed intervention", undefined, false, "delayed-user", "intervening-user"),
        evidenceMarker("delayed-user", "leaf-one", "task-one"),
        message("user", "other task", undefined, false, "other-task"),
        message("assistant", "input leaf two", undefined, false, "leaf-two", "task-one"),
        message("user", "wrong task anchor", undefined, false, "wrong-anchor-user", "leaf-two"),
        evidenceMarker("wrong-anchor-user", "leaf-two", "other-task"),
        message("user", "unknown schema marker", undefined, false, "unknown-schema", "leaf-one"),
        JSON.stringify(extraMetadata),
        message("user", "target with duplicate markers", undefined, false, "multi-marker-user", "leaf-one"),
        evidenceMarker("multi-marker-user", "leaf-one", "task-one", "first-marker"),
        evidenceMarker("multi-marker-user", "leaf-one", "task-one", "second-marker"),
        message("user", "duplicate task one", undefined, false, "duplicate-task"),
        message("user", "duplicate task two", undefined, false, "duplicate-task"),
        message("assistant", "duplicate input leaf", undefined, false, "duplicate-leaf", "duplicate-task"),
        message("user", "duplicate ID target", undefined, false, "duplicate-user", "duplicate-leaf"),
        evidenceMarker("duplicate-user", "duplicate-leaf", "duplicate-task"),
        message("user", "out of range marker", undefined, false, "out-of-range-user", "leaf-one"),
        JSON.stringify(outOfRangeMarker),
      ],
    });

    await runMiner({ ...f, consent: "yes" });
    const { candidates } = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(candidates.map(({ id, text, context }) => ({ id, text, context })), [
      { id: "candidate-1", text: "valid intervention", context: "task one" },
    ]);
    assert.doesNotMatch(candidates[0].id, /\.jsonl|2026|fixture/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("excludes evidence with missing or cyclic parent chains", async () => {
  const f = await fixture();
  try {
    await writeSession(f.sessions, "cycles.jsonl", {
      cwd: f.project,
      rows: [
        message("user", "task anchor", undefined, false, "anchor"),
        message("assistant", "input leaf", undefined, false, "input-leaf", "anchor"),
        message("toolResult", "cycle one", undefined, false, "cycle-one", "cycle-two"),
        message("toolResult", "cycle two", undefined, false, "cycle-two", "cycle-one"),
        message("user", "cyclic parent candidate", undefined, false, "cyclic", "cycle-one"),
        evidenceMarker("cyclic", "input-leaf", "anchor"),
        message("user", "missing parent candidate", undefined, false, "missing", "not-present"),
        evidenceMarker("missing", "input-leaf", "anchor"),
      ],
    });
    await runMiner({ ...f, consent: "yes" });
    const { candidates } = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(candidates, [], "broken and cyclic branches are excluded");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("uses only the configured agent's sessions root and supports a custom agent directory", async () => {
  const f = await fixture("pi-card-custom-agent-");
  const defaultSessions = path.join(f.root, "outside-sessions");
  try {
    await mkdir(defaultSessions);
    await writeSession(f.sessions, "custom.jsonl", { cwd: f.project, rows: capturedRows("from custom config", { prefix: "custom" }) });
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
      await writeSession(f.sessions, `session-${i}.jsonl`, { cwd: f.project, timestamp: `${date}T${String(i).padStart(2, "0")}:00:00Z`, rows: capturedRows(`candidate ${i}`, { prefix: `candidate-${i}` }) });
    }
    await runMiner({ ...f, consent: "yes", files: 5, limit: 2 });
    const file = await outputFile(f);
    const first = await readFile(file, "utf8");
    const result = JSON.parse(first);
    assert.equal(result.selectedSessionFiles, 5);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.skippedEvidenceMarkers, 0);
    assert.equal(result.omittedEvidenceMarkers, 3);
    await assert.rejects(runMiner({ ...f, consent: "yes", files: 5, limit: 2 }));
    assert.equal(await readFile(file, "utf8"), first);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("limits session reads to five files in the current project's directory", async () => {
  const f = await fixture("pi-card-bounded-discovery-");
  try {
    const unrelated = path.join(f.sessionsRoot, "--unrelated-project--");
    await mkdir(unrelated);
    for (let i = 0; i < 2_100; i++) {
      await writeFile(path.join(unrelated, sessionFilename(`${date}T12:00:00.000Z`, `unrelated-${i}`)), "not inspected\n");
    }
    for (let i = 0; i < 8; i++) {
      await writeSession(f.sessions, `target-${i}.jsonl`, {
        cwd: f.project,
        timestamp: `${date}T${String(i).padStart(2, "0")}:00:00.000Z`,
        rows: capturedRows(`target ${i}`, { prefix: `target-${i}` }),
      });
    }

    const instrumentation = await sessionReadInstrumentation(f.root);
    await runMiner({
      ...f,
      consent: "yes",
      env: {
        NODE_OPTIONS: `--import ${instrumentation.hook}`,
        PI_CARD_SESSION_OPEN_LOG: instrumentation.openLog,
        PI_CARD_HEADER_READ_LOG: instrumentation.headerReadLog,
      },
    });
    const opened = (await readFile(instrumentation.openLog, "utf8")).trim().split("\n");
    const openedPaths = new Set(opened);
    assert.equal(openedPaths.size, 5, "only five selected session files are opened");
    assert.equal(opened.length, 10, "each selected file is opened once for its header and once for its transcript");
    const canonicalSessions = await realpath(f.sessions);
    assert.ok([...openedPaths].every((file) => file.startsWith(canonicalSessions + path.sep)));
    const headerReads = (await readFile(instrumentation.headerReadLog, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(headerReads.every(({ requested, bytesRead }) => requested === 1 && bytesRead === 1), "header reads never overread beyond a byte");
    for (const file of openedPaths) {
      const content = await readFile(file, "utf8");
      const expectedHeaderBytes = Buffer.byteLength(content.slice(0, content.indexOf("\n") + 1));
      assert.equal(headerReads.filter((read) => read.name === file).length, expectedHeaderBytes);
    }
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.equal(result.selectedSessionFiles, 5);
    assert.deepEqual(result.candidates.map(({ text }) => text), ["target 7", "target 6", "target 5", "target 4", "target 3"]);
    assert.deepEqual(result.candidates.map(({ id }) => id), ["candidate-1", "candidate-2", "candidate-3", "candidate-4", "candidate-5"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("validates lossy Pi project-directory collisions before reading transcripts", async () => {
  const f = await fixture("pi-card-session-dir-collision-");
  const requestedProject = path.join(f.root, "a-b", "c");
  const collidingProject = path.join(f.root, "a", "b-c");
  try {
    await mkdir(requestedProject, { recursive: true });
    await mkdir(collidingProject, { recursive: true });
    assert.equal(sessionDirectoryName(requestedProject), sessionDirectoryName(collidingProject));
    const sharedDirectory = path.join(f.sessionsRoot, sessionDirectoryName(requestedProject));
    await mkdir(sharedDirectory);
    const foreignFile = sessionFilename(`${date}T14:00:00.000Z`, "foreign");
    await writeFile(path.join(sharedDirectory, foreignFile), [
      JSON.stringify({ type: "session", cwd: collidingProject, timestamp: `${date}T14:00:00.000Z` }),
      "{malformed transcript must not be opened}",
    ].join("\n") + "\n");
    await writeSession(sharedDirectory, sessionFilename(`${date}T13:00:00.000Z`, "requested"), {
      cwd: requestedProject,
      timestamp: `${date}T13:00:00.000Z`,
      rows: capturedRows("requested project only", { prefix: "collision-requested" }),
    });

    const instrumentation = await sessionReadInstrumentation(f.root);
    const instrumentedEnv = {
      NODE_OPTIONS: `--import ${instrumentation.hook}`,
      PI_CARD_SESSION_OPEN_LOG: instrumentation.openLog,
      PI_CARD_HEADER_READ_LOG: instrumentation.headerReadLog,
    };
    await runMiner({ ...f, project: requestedProject, consent: "yes", env: instrumentedEnv });
    let result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(result.candidates.map(({ text }) => text), ["requested project only"]);
    assert.equal(result.skippedSessionHeaders, 1);
    const canonicalSharedDirectory = await realpath(sharedDirectory);
    const canonicalForeignFile = path.join(canonicalSharedDirectory, foreignFile);
    const firstOpenLog = (await readFile(instrumentation.openLog, "utf8")).trim().split("\n");
    assert.equal(firstOpenLog.filter((file) => file === canonicalForeignFile).length, 1, "foreign transcript is never opened");
    const foreignHeader = (await readFile(path.join(sharedDirectory, foreignFile), "utf8")).split("\n", 1)[0] + "\n";
    const foreignReads = (await readFile(instrumentation.headerReadLog, "utf8")).trim().split("\n").map(JSON.parse)
      .filter((read) => read.name === canonicalForeignFile);
    assert.equal(foreignReads.length, Buffer.byteLength(foreignHeader), "only the foreign session's first line is read");
    assert.ok(foreignReads.every(({ requested, bytesRead }) => requested === 1 && bytesRead === 1));

    await rm(await outputFile(f));
    await writeFile(instrumentation.openLog, "");
    await writeFile(instrumentation.headerReadLog, "");
    await writeFile(path.join(sharedDirectory, foreignFile), "not a valid session header\n");
    await runMiner({ ...f, project: requestedProject, consent: "yes", env: instrumentedEnv });
    result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(result.candidates.map(({ text }) => text), ["requested project only"]);
    assert.equal(result.skippedSessionHeaders, 1);

    await rm(await outputFile(f));
    await writeFile(instrumentation.openLog, "");
    await writeFile(instrumentation.headerReadLog, "");
    await writeFile(path.join(sharedDirectory, foreignFile), "null\n");
    await runMiner({ ...f, project: requestedProject, consent: "yes", files: 1, env: instrumentedEnv });
    result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(result.candidates, [], "a null header is skipped and consumes the preselected one-file cap");
    assert.equal(result.selectedSessionFiles, 0);
    assert.equal(result.skippedSessionHeaders, 1);
    const oneFileReads = (await readFile(instrumentation.openLog, "utf8")).trim().split("\n");
    assert.deepEqual(oneFileReads, [canonicalForeignFile], "the older requested-project transcript stays unopened");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("skips relative, missing, and non-string header cwd values before transcript reads", async () => {
  const f = await fixture("pi-card-session-cwd-validation-");
  const requestedProject = path.join(f.root, "a-b", "c");
  const collidingProject = path.join(f.root, "a", "b-c");
  try {
    await mkdir(requestedProject, { recursive: true });
    await mkdir(collidingProject, { recursive: true });
    const sharedDirectory = path.join(f.sessionsRoot, sessionDirectoryName(requestedProject));
    await mkdir(sharedDirectory);
    const foreignFile = sessionFilename(`${date}T14:00:00.000Z`, "foreign-cwd");
    const targetFile = sessionFilename(`${date}T13:00:00.000Z`, "requested-cwd");
    await writeSession(sharedDirectory, targetFile, {
      cwd: requestedProject,
      timestamp: `${date}T13:00:00.000Z`,
      rows: capturedRows("requested project only", { prefix: "cwd-requested" }),
    });

    const variants = [
      { name: "relative cwd", header: { type: "session", cwd: ".", timestamp: `${date}T14:00:00.000Z` } },
      { name: "missing cwd", header: { type: "session", timestamp: `${date}T14:00:00.000Z` } },
      { name: "non-string cwd", header: { type: "session", cwd: null, timestamp: `${date}T14:00:00.000Z` } },
    ];
    const instrumentation = await sessionReadInstrumentation(f.root);
    const env = {
      NODE_OPTIONS: `--import ${instrumentation.hook}`,
      PI_CARD_SESSION_OPEN_LOG: instrumentation.openLog,
      PI_CARD_HEADER_READ_LOG: instrumentation.headerReadLog,
    };
    const canonicalForeignFile = path.join(await realpath(sharedDirectory), foreignFile);

    for (const { name, header } of variants) {
      await rm(await outputFile(f), { force: true });
      await writeFile(instrumentation.openLog, "");
      await writeFile(instrumentation.headerReadLog, "");
      await writeFile(path.join(sharedDirectory, foreignFile), [
        JSON.stringify(header),
        message("user", "foreign transcript must not be read", `${date}T14:00:00.000Z`),
      ].join("\n") + "\n");

      await runMiner({ ...f, project: requestedProject, cwd: requestedProject, consent: "yes", env });
      const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
      assert.deepEqual(result.candidates.map(({ text }) => text), ["requested project only"], name);
      assert.equal(result.skippedSessionHeaders, 1, name);
      const opened = (await readFile(instrumentation.openLog, "utf8")).trim().split("\n");
      assert.equal(opened.filter((file) => file === canonicalForeignFile).length, 1, `${name}: header only; no transcript open`);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("preserves a verified shell project alias without trusting unrelated PWD values", async () => {
  const f = await fixture("pi-card-shell-project-alias-");
  const alias = `${f.project}-shell-alias`;
  const foreignProject = path.join(f.root, "foreign-project");
  try {
    await symlink(f.project, alias);
    const aliasSessions = path.join(f.sessionsRoot, sessionDirectoryName(alias));
    await mkdir(aliasSessions);
    await writeSession(aliasSessions, "alias.jsonl", { cwd: f.project, rows: capturedRows("verified shell alias", { prefix: "shell-alias" }) });
    await runMiner({ ...f, consent: "yes", env: { PWD: alias } });
    let result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(result.candidates.map(({ text }) => text), ["verified shell alias"]);

    await rm(await outputFile(f));
    await mkdir(foreignProject);
    const foreignSessions = path.join(f.sessionsRoot, sessionDirectoryName(foreignProject));
    await mkdir(foreignSessions);
    await writeSession(foreignSessions, "foreign.jsonl", { cwd: foreignProject, rows: [message("user", "must stay out of scope")] });
    await runMiner({ ...f, consent: "yes", env: { PWD: foreignProject } });
    result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(result.candidates, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("accepts a symlinked configured agent path and resolves it before session access", async () => {
  const f = await fixture("pi-card-agent-alias-");
  const alias = `${f.agentDir}-alias`;
  try {
    await symlink(f.agentDir, alias);
    await writeSession(f.sessions, "alias-session.jsonl", { cwd: f.project, rows: capturedRows("alias path works", { prefix: "agent-alias" }) });
    await runMiner({ ...f, consent: "yes", env: { PI_CODING_AGENT_DIR: alias } });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.deepEqual(result.candidates.map(({ text }) => text), ["alias path works"]);
  } finally {
    await rm(alias, { force: true });
    await rm(f.root, { recursive: true, force: true });
  }
});

test("ignores symlinks and fails closed on malformed matching session data", async () => {
  const f = await fixture();
  try {
    const external = await writeSession(f.root, "external.jsonl", { cwd: f.project, rows: [message("user", "external")] });
    await symlink(external, path.join(f.sessions, sessionFilename(`${date}T12:00:00.000Z`, "linked")));
    await runMiner({ ...f, consent: "yes" });
    assert.equal(JSON.parse(await readFile(await outputFile(f), "utf8")).selectedSessionFiles, 0);

    await rm(await outputFile(f));
    await writeFile(path.join(f.sessions, sessionFilename(`${date}T12:00:00.000Z`, "broken")), `${JSON.stringify({ type: "session", cwd: f.project, timestamp: `${date}T12:00:00Z` })}\n{bad json}\n`);
    await assert.rejects(runMiner({ ...f, consent: "yes" }), /Malformed selected session JSONL/);
    await assert.rejects(readFile(await outputFile(f)), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("rejects symlinked session roots, unbounded paths, and reversed ranges", async () => {
  const f = await fixture();
  try {
    const outsideSessions = path.join(f.root, "outside-sessions");
    await mkdir(outsideSessions);
    await rm(f.sessionsRoot, { recursive: true });
    await symlink(outsideSessions, f.sessionsRoot);
    const env = { ...process.env, PI_CODING_AGENT_DIR: f.root };
    await assert.rejects(execFile(process.execPath, [script, "--consent", "yes", "--project", f.project, "--since", date, "--until", date, "--output", f.output], { env }), /Pi sessions directory must be a real directory/);
    await assert.rejects(runMiner({ ...f, consent: "yes", output: "../outside.json" }), /Usage: mine-sessions/);
    await assert.rejects(runMiner({ ...f, consent: "yes", files: 6 }), /--files must be between/);
    const args = ["--consent", "yes", "--project", f.project, "--since", "2026-09-21", "--until", date, "--output", "reverse.json"];
    await assert.rejects(execFile(process.execPath, [script, ...args], { env }), /--since must be on or before/);
    const invalidDate = ["--consent", "yes", "--project", f.project, "--since", "2026-02-30", "--until", "2026-03-02", "--output", f.output];
    await assert.rejects(execFile(process.execPath, [script, ...invalidDate], { env }), /Usage: mine-sessions/);
    await assert.rejects(readFile(await outputFile(f)), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("canonicalizes the requested project path before matching session metadata", async () => {
  const f = await fixture();
  const alias = `${f.project}-alias`;
  try {
    await symlink(f.project, alias);
    const aliasSessions = path.join(f.sessionsRoot, sessionDirectoryName(alias));
    await mkdir(aliasSessions);
    await writeSession(aliasSessions, "canonical.jsonl", { cwd: f.project, rows: capturedRows("canonical project match", { prefix: "canonical" }) });
    await runMiner({ ...f, project: alias, consent: "yes" });
    const result = JSON.parse(await readFile(await outputFile(f), "utf8"));
    assert.equal(result.project, "[REDACTED_PATH]");
    assert.deepEqual(result.candidates.map(({ text }) => text), ["canonical project match"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
