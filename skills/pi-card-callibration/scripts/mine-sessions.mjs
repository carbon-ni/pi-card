#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const MAX_FILES = 5;
const MAX_CANDIDATES = 20;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_CHARS = 240;
const MAX_MESSAGE_CHARS = 1_000;

function parseArgs(args) {
  const options = { files: MAX_FILES, limit: MAX_CANDIDATES };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--output", "--html", "--project", "--since", "--until", "--files", "--limit", "--consent"].includes(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    const name = key.slice(2);
    options[name] = ["output", "html", "project", "since", "until", "consent"].includes(name) ? value : Number(value);
    if (name === "consent" && value !== "yes") throw new Error("Explicit consent is required before reading session JSONL");
    if ((name === "files" && (!Number.isInteger(options.files) || options.files < 1 || options.files > MAX_FILES)) ||
        (name === "limit" && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_CANDIDATES))) {
      throw new Error(`${key} must be between 1 and ${name === "files" ? MAX_FILES : MAX_CANDIDATES}`);
    }
  }
  if (options.consent !== "yes") throw new Error("Explicit consent is required before reading session JSONL");
  const validDate = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  };
  const validFilename = (value) => value && path.basename(value) === value && ![".", ".."].includes(value);
  if (!validFilename(options.output) || (options.html && !validFilename(options.html)) || options.html === options.output || !options.project || !path.isAbsolute(options.project) || !validDate(options.since) || !validDate(options.until)) {
    throw new Error("Usage: mine-sessions.mjs --consent yes --project <absolute-cwd> --since YYYY-MM-DD --until YYYY-MM-DD --output <filename> [--html <filename>] [--files 1-5] [--limit 1-20]");
  }
  if (options.since > options.until) throw new Error("--since must be on or before --until");
  return options;
}

function projectSessionDirectory(project) {
  const withoutLeadingSlash = project.startsWith("/") ? project.slice(1) : project;
  return `--${withoutLeadingSlash.replaceAll("/", "-")}--`;
}

function sessionDateFromFilename(filename) {
  const match = /^(\d{4}-\d{2}-\d{2})T[^/]+Z_[^/]+\.jsonl$/.exec(filename);
  return match?.[1] ?? null;
}

async function collectProjectFiles(root, projects, since, until, limit) {
  const candidates = [];
  for (const project of projects) {
    const directory = path.join(root, projectSessionDirectory(project));
    let directoryStat;
    try { directoryStat = await lstat(directory); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;
    const canonicalDirectory = await realpath(directory);
    const relativeDirectory = path.relative(root, canonicalDirectory);
    if (relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) continue;
    const entries = await readdir(canonicalDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const date = sessionDateFromFilename(entry.name);
      if (!entry.isFile() || !date || date < since || date > until) continue;
      candidates.push({ file: path.join(canonicalDirectory, entry.name), name: entry.name });
    }
  }
  candidates.sort((a, b) => b.name.localeCompare(a.name) || a.file.localeCompare(b.file));
  return candidates.slice(0, limit).map(({ file }) => file);
}

async function withNoFollow(file, callback) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Not a regular file");
    return await callback(handle, metadata);
  } finally {
    await handle.close();
  }
}

async function readHeader(file) {
  return withNoFollow(file, async (handle) => {
    const byte = Buffer.alloc(1);
    const header = [];
    for (let position = 0; position < 16_384; position++) {
      const { bytesRead } = await handle.read(byte, 0, 1, position);
      if (bytesRead === 0) throw new Error("Incomplete session header");
      if (byte[0] === 0x0a) {
        const parsed = JSON.parse(Buffer.from(header).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Session header must be a JSON object");
        }
        return parsed;
      }
      header.push(byte[0]);
    }
    throw new Error("Header exceeds 16 KB");
  });
}

async function readSession(file) {
  return withNoFollow(file, async (handle, metadata) => {
    if (metadata.size > MAX_FILE_BYTES) throw new Error(`Session file exceeds ${MAX_FILE_BYTES} bytes`);
    return handle.readFile("utf8");
  });
}

function timestampInRange(value, earliest, latest) {
  const timestamp = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) && timestamp >= earliest && timestamp <= latest;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((part) =>
    !part || typeof part !== "object" || part.type !== "text" || typeof part.text !== "string",
  )) return "";
  return content.map((part) => part.text).join("");
}

const EVIDENCE_TYPE = "pi-card.intervention";
const EVIDENCE_DATA_KEYS = [
  "activeAtInput", "deliveryAtPersistence", "inputKind", "inputLeafEntryId",
  "observedAction", "schemaVersion", "source", "streamingBehavior", "taskAnchorEntryId",
];

function isEvidenceMarker(entry) {
  const data = entry.data;
  if (entry.type !== "custom" || entry.customType !== EVIDENCE_TYPE || !data || typeof data !== "object" || Array.isArray(data)) return false;
  if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(EVIDENCE_DATA_KEYS)) return false;
  return data.schemaVersion === 3 && data.source === "interactive" && typeof data.activeAtInput === "boolean" &&
    (data.activeAtInput ? typeof data.taskAnchorEntryId === "string" && data.taskAnchorEntryId.length > 0 : data.taskAnchorEntryId === null) &&
    (data.activeAtInput
      ? typeof data.inputLeafEntryId === "string" && data.inputLeafEntryId.length > 0
      : data.inputLeafEntryId === null || typeof data.inputLeafEntryId === "string" && data.inputLeafEntryId.length > 0) &&
    ["jevRouted", "interruptCard", "followUpCard", "brainstormCard"].includes(data.inputKind) &&
    ["send", "continue", "queued_followUp", "abort_requested", "transform"].includes(data.observedAction) &&
    ["normal", "steer", "followUp"].includes(data.deliveryAtPersistence) &&
    (data.streamingBehavior === null || data.streamingBehavior === "steer" || data.streamingBehavior === "followUp");
}

function ancestorChain(parentId, entriesById, ambiguousIds) {
  if (typeof parentId !== "string") return null;
  const chain = [];
  const visited = new Set();
  let currentId = parentId;
  for (let depth = 0; depth < 1_000; depth++) {
    if (visited.has(currentId) || ambiguousIds.has(currentId)) return null;
    visited.add(currentId);
    const entry = entriesById.get(currentId);
    if (!entry || !entry.parentValid) return null;
    chain.push(entry);
    if (entry.parentId === null) return chain;
    if (typeof entry.parentId !== "string") return null;
    currentId = entry.parentId;
  }
  return null;
}

function idleParentChainMatches(target, inputLeafEntryId, entriesById, ambiguousIds) {
  let parentId = target.parentId;
  if (inputLeafEntryId === null && parentId === null) return target.parentWasNull;

  const visited = new Set();
  while (parentId !== inputLeafEntryId) {
    if (typeof parentId !== "string" || visited.has(parentId) || ambiguousIds.has(parentId)) return false;
    visited.add(parentId);
    const parent = entriesById.get(parentId);
    if (!parent || !parent.parentValid || parent.type !== "custom" || parent.customType !== "pi-card.routing") return false;
    parentId = parent.parentId;
    if (parentId === null) return inputLeafEntryId === null && parent.parentWasNull;
    if (typeof parentId !== "string") return false;
  }
  return inputLeafEntryId !== null && entriesById.has(inputLeafEntryId) && !ambiguousIds.has(inputLeafEntryId);
}

function resolveTaskAnchor(target, marker, entriesById, ambiguousIds, earliest, latest) {
  if (!isEvidenceMarker(marker) || ambiguousIds.has(marker.id) || ambiguousIds.has(target.id)) return null;
  if (marker.parentId !== target.id || target.type !== "message" || target.message?.role !== "user" || !target.parentValid) return null;
  if (!timestampInRange(marker.timestamp, earliest, latest) || !timestampInRange(target.timestamp, earliest, latest) || !target.message.text) return null;

  if (!marker.data.activeAtInput) {
    if (!idleParentChainMatches(target, marker.data.inputLeafEntryId, entriesById, ambiguousIds)) return null;
    return { taskAnchor: null };
  }

  const chain = ancestorChain(target.parentId, entriesById, ambiguousIds);
  if (!chain) return null;
  const inputIndex = chain.findIndex((entry) => entry.id === marker.data.inputLeafEntryId);
  const anchorIndex = chain.findIndex((entry) => entry.id === marker.data.taskAnchorEntryId);
  if (inputIndex < 0 || anchorIndex < inputIndex) return null;

  const taskAnchor = chain[anchorIndex];
  if (taskAnchor.type !== "message" || taskAnchor.message?.role !== "user" || !taskAnchor.message.text ||
      !timestampInRange(taskAnchor.timestamp, earliest, latest)) return null;

  const entriesBetween = [...chain.slice(0, inputIndex), ...chain.slice(inputIndex + 1, anchorIndex)];
  if (entriesBetween.some((entry) => entry.type === "message" && entry.message?.role === "user")) return null;
  return { taskAnchor };
}

function redact(text) {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:sk|pk|api|token|key)[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_SECRET]")
    .replace(/\b(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/gi, "[REDACTED_SECRET]")
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, "[REDACTED_PHONE]")
    .replaceAll(os.homedir(), "[HOME]");
}

const REVIEWER_SCRIPT = `(() => {
  const source = JSON.parse(document.getElementById("candidate-data").textContent);
  const host = document.getElementById("candidate-list");
  const summary = document.getElementById("summary");
  const reviews = source.candidates.map((candidate) => ({ candidate, label: "", text: candidate.text, context: candidate.context, stopConfirmed: false }));
  const labels = [["", "Unreviewed"], ["steer", "Steer"], ["stop", "Stop"], ["followUp", "Follow up"], ["other", "Other"], ["unclear", "Unclear"], ["skip", "Skip"]];
  const exportButton = document.getElementById("download");

  function updateSummary() {
    const counts = Object.fromEntries(labels.map(([value]) => [value || "unreviewed", 0]));
    reviews.forEach((review) => { counts[review.label || "unreviewed"]++; });
    summary.textContent = "Total: " + reviews.length + " · Unreviewed: " + counts.unreviewed + " · Steer: " + counts.steer + " · Stop: " + counts.stop + " · Follow up: " + counts.followUp + " · Other: " + counts.other + " · Unclear: " + counts.unclear + " · Skip: " + counts.skip;
  }

  reviews.forEach((review, index) => {
    const card = document.createElement("article");
    const heading = document.createElement("h2");
    heading.textContent = "Example " + (index + 1);
    card.append(heading);
    const behavior = document.createElement("p");
    behavior.textContent = "Observed Pi behavior (not a label): " + review.candidate.activeStatus + " · " + review.candidate.inputKind + " · action " + review.candidate.observedAction + " · persisted delivery " + review.candidate.deliveryAtPersistence;
    card.append(behavior);
    const messageLabel = document.createElement("label");
    messageLabel.textContent = "Persisted Pi Card user message (may differ from what you typed)";
    const message = document.createElement("textarea");
    message.value = review.text;
    message.rows = 4;
    messageLabel.append(message);
    card.append(messageLabel);
    const contextLabel = document.createElement("label");
    contextLabel.textContent = "Task context (active input only; captured anchor)";
    const context = document.createElement("textarea");
    context.value = review.context;
    context.rows = 2;
    contextLabel.append(context);
    card.append(contextLabel);
    const choiceLabel = document.createElement("label");
    choiceLabel.textContent = "Human label";
    const choice = document.createElement("select");
    labels.forEach(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      choice.append(option);
    });
    choice.addEventListener("change", () => {
      review.label = choice.value;
      if (choice.value !== "stop") review.stopConfirmed = false;
      stopLabel.hidden = choice.value !== "stop";
      stopConfirm.checked = false;
      review.stopConfirmed = false;
      updateSummary();
    });
    choiceLabel.append(choice);
    card.append(choiceLabel);
    const stopLabel = document.createElement("label");
    stopLabel.hidden = true;
    const stopConfirm = document.createElement("input");
    stopConfirm.type = "checkbox";
    stopConfirm.addEventListener("change", () => { review.stopConfirmed = stopConfirm.checked; });
    stopLabel.append(stopConfirm, document.createTextNode(" I explicitly confirm this individual stop example."));
    card.append(stopLabel);
    const revokeStopConfirmation = () => {
      if (review.label !== "stop") return;
      stopConfirm.checked = false;
      review.stopConfirmed = false;
    };
    message.addEventListener("input", () => { review.text = message.value; revokeStopConfirmation(); });
    context.addEventListener("input", () => { review.context = context.value; revokeStopConfirmation(); });
    host.append(card);
  });

  exportButton.addEventListener("click", () => {
    if (reviews.some((review) => review.label === "stop" && !review.stopConfirmed)) {
      summary.textContent = "Confirm each stop example individually before export.";
      return;
    }
    const payload = {
      dateRange: source.dateRange,
      candidates: reviews.filter((review) => review.label).map((review) => ({
        id: review.candidate.id, text: review.text, context: review.context,
        inputKind: review.candidate.inputKind,
        observedAction: review.candidate.observedAction,
        deliveryAtPersistence: review.candidate.deliveryAtPersistence,
        activeStatus: review.candidate.activeStatus, label: review.label,
        stopConfirmed: review.label === "stop" && review.stopConfirmed,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "pi-card-calibration-reviewed.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });
  updateSummary();
})();`;

function jsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function renderReviewer(result) {
  const scriptHash = createHash("sha256").update(REVIEWER_SCRIPT).digest("base64");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>Pi Card local calibration review</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;color:#18212b;background:#f7f8fa}h1{font-size:1.7rem}article{background:white;border:1px solid #cbd2da;border-radius:8px;padding:1rem;margin:1rem 0}label{display:block;font-weight:600;margin:.8rem 0}[hidden]{display:none!important}textarea,select{display:block;box-sizing:border-box;width:100%;font:inherit;padding:.6rem;border:1px solid #8793a1;border-radius:4px}input[type=checkbox]{width:1.1rem;height:1.1rem}button{font:inherit;padding:.65rem 1rem;border:0;border-radius:4px;background:#123f70;color:white;cursor:pointer}#summary{font-weight:600;position:sticky;top:0;background:#f7f8fa;padding:.6rem 0}small{color:#414d59}
</style>
</head>
<body>
<h1>Local Pi Card calibration review</h1>
<p>This page makes no network requests. Review and edit each redacted example, then label it. Pi Card configuration is unchanged. Stop labels require a separate per-example confirmation.</p>
<p><small>Date range: ${result.dateRange.since} through ${result.dateRange.until} UTC. Delete this sensitive page after review.</small></p>
<p id="summary" aria-live="polite"></p>
<div id="candidate-list"></div>
<button id="download" type="button">Download reviewed labels JSON</button>
<p><small>Your browser chooses the download location and file permissions. Save the reviewed JSON in a private folder, restrict its access, and delete it when finished; it may contain sensitive edited text.</small></p>
<script id="candidate-data" type="application/json">${jsonForHtml(result)}</script>
<script>${REVIEWER_SCRIPT}</script>
</body>
</html>
`;
}

async function writeOutputs({ htmlPath, htmlText, outputPath, outputText }) {
  const created = [];
  const createFile = async (file, content) => {
    const handle = await open(file, "wx", 0o600);
    created.push(file);
    try { await handle.writeFile(content); }
    finally { await handle.close(); }
  };
  try {
    if (htmlPath) await createFile(htmlPath, htmlText);
    await createFile(outputPath, outputText);
  } catch (error) {
    const cleanupErrors = [];
    for (const file of created.reverse()) {
      try { await unlink(file); }
      catch (cleanupError) { if (cleanupError.code !== "ENOENT") cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw new Error(`${error.message}; failed to remove partial output`);
    throw error;
  }
}

async function mine({ files, html, limit, output, project, since, until }) {
  const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  let canonicalAgentDir;
  try { canonicalAgentDir = await realpath(agentDir); }
  catch { throw new Error("Configured Pi agent directory does not exist"); }
  const agentStat = await lstat(canonicalAgentDir);
  if (agentStat.isSymbolicLink() || !agentStat.isDirectory()) throw new Error("Pi agent config directory must resolve to a real directory");
  const sessions = path.join(canonicalAgentDir, "sessions");
  const sessionsStat = await lstat(sessions);
  if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) throw new Error("Pi sessions directory must be a real directory, not a symlink");
  const canonicalRoot = await realpath(sessions);
  if (canonicalRoot !== sessions) throw new Error("Pi sessions directory resolves outside the configured agent directory");
  const outputPath = path.join(canonicalAgentDir, output);
  const projectPath = await realpath(project);
  const requestedProjectPath = path.resolve(project);
  const projectPaths = [projectPath, requestedProjectPath];
  if (typeof process.env.PWD === "string" && path.isAbsolute(process.env.PWD)) {
    const shellProjectPath = path.resolve(process.env.PWD);
    try {
      if (await realpath(shellProjectPath) === projectPath) projectPaths.push(shellProjectPath);
    } catch { /* Ignore stale or invalid PWD values. */ }
  }
  const uniqueProjectPaths = [...new Set(projectPaths)];
  const earliest = Date.parse(`${since}T00:00:00Z`);
  const latest = Date.parse(`${until}T23:59:59.999Z`);
  const filenameCandidates = await collectProjectFiles(canonicalRoot, uniqueProjectPaths, since, until, files);
  const eligible = [];
  let skippedSessionHeaders = 0;
  for (const file of filenameCandidates) {
    let header;
    try { header = await readHeader(file); }
    catch {
      skippedSessionHeaders++;
      continue;
    }
    const timestamp = Date.parse(header.timestamp);
    if (header.type !== "session" || typeof header.cwd !== "string" || !path.isAbsolute(header.cwd) ||
        !Number.isFinite(timestamp) || timestamp < earliest || timestamp > latest) {
      skippedSessionHeaders++;
      continue;
    }
    let headerProject;
    try { headerProject = await realpath(header.cwd); }
    catch {
      skippedSessionHeaders++;
      continue;
    }
    if (headerProject === projectPath) eligible.push({ file, timestamp });
    else skippedSessionHeaders++;
  }
  eligible.sort((a, b) => b.timestamp - a.timestamp || a.file.localeCompare(b.file));
  const selected = eligible;
  const results = [];
  let skippedEvidenceMarkers = 0;
  let omittedEvidenceMarkers = 0;
  for (const { file } of selected) {
    let contents;
    try { contents = await readSession(file); }
    catch { throw new Error(`Oversized or unreadable selected session (${path.basename(file)}); no output written`); }
    const lines = contents.split("\n");
    const entriesById = new Map();
    const ambiguousIds = new Set();
    const markerCountsByTarget = new Map();
    const markerRows = [];
    for (let index = 1; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let row;
      try { row = JSON.parse(lines[index]); }
      catch { throw new Error(`Malformed selected session JSONL (${path.basename(file)}:${index + 1}); no output written`); }
      if (row.type === "custom" && row.customType === EVIDENCE_TYPE && typeof row.parentId === "string") {
        markerCountsByTarget.set(row.parentId, (markerCountsByTarget.get(row.parentId) ?? 0) + 1);
      }
      const entry = {
        id: row.id,
        type: row.type,
        customType: row.customType,
        data: row.data,
        rowNumber: index + 1,
        parentId: typeof row.parentId === "string" ? row.parentId : null,
        parentValid: row.parentId === undefined || row.parentId === null || typeof row.parentId === "string",
        parentWasNull: row.parentId === null,
        timestamp: row.timestamp,
        message: null,
      };
      if (row.type === "custom" && row.customType === EVIDENCE_TYPE) markerRows.push(entry);
      if (typeof row.id === "string" && !ambiguousIds.has(row.id)) {
        if (entriesById.has(row.id)) {
          entriesById.delete(row.id);
          ambiguousIds.add(row.id);
        } else {
          entriesById.set(row.id, entry);
        }
      }
      if (row.type !== "message" || !["user", "assistant"].includes(row.message?.role)) continue;
      const text = textOf(row.message.content);
      if (text) entry.message = { role: row.message.role, text };
    }
    for (let i = markerRows.length - 1; i >= 0; i--) {
      const marker = markerRows[i];
      if (!isEvidenceMarker(marker) || typeof marker.id !== "string" || ambiguousIds.has(marker.id) ||
          typeof marker.parentId !== "string" || markerCountsByTarget.get(marker.parentId) !== 1) {
        skippedEvidenceMarkers++;
        continue;
      }
      const target = entriesById.get(marker.parentId);
      if (!target || ambiguousIds.has(target.id)) {
        skippedEvidenceMarkers++;
        continue;
      }
      const evidence = resolveTaskAnchor(target, marker, entriesById, ambiguousIds, earliest, latest);
      if (!evidence || target.message.text.length > MAX_MESSAGE_CHARS) {
        skippedEvidenceMarkers++;
        continue;
      }
      if (results.length >= limit) {
        omittedEvidenceMarkers++;
        continue;
      }
      results.push({
        id: `candidate-${results.length + 1}`,
        text: redact(target.message.text),
        context: evidence.taskAnchor ? redact(evidence.taskAnchor.message.text).slice(-MAX_CONTEXT_CHARS).trim() : "",
        inputKind: marker.data.inputKind,
        observedAction: marker.data.observedAction,
        deliveryAtPersistence: marker.data.deliveryAtPersistence,
        activeStatus: marker.data.activeAtInput ? "active" : "idle",
        label: null,
      });
    }
  }
  const result = {
    source: "local-pi-sessions",
    project: "[REDACTED_PATH]",
    dateRange: { since, until, timeZone: "UTC" },
    selectedSessionFiles: selected.length,
    skippedSessionHeaders,
    skippedEvidenceMarkers,
    omittedEvidenceMarkers,
    candidates: results,
  };
  await writeOutputs({
    htmlPath: html ? path.join(canonicalAgentDir, html) : null,
    htmlText: html ? renderReviewer(result) : null,
    outputPath,
    outputText: `${JSON.stringify(result, null, 2)}\n`,
  });
  return result;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await mine(options);
  console.log(`Wrote ${result.candidates.length} redacted candidates from ${result.selectedSessionFiles} session files${result.skippedSessionHeaders ? `; skipped ${result.skippedSessionHeaders} non-matching or unreadable session headers` : ""}${result.skippedEvidenceMarkers ? `; skipped ${result.skippedEvidenceMarkers} invalid or ambiguous evidence markers` : ""}${result.omittedEvidenceMarkers ? `; omitted ${result.omittedEvidenceMarkers} additional valid candidates after reaching the limit` : ""}. Candidate JSON: ${options.output}${options.html ? `; local HTML reviewer: ${options.html}` : ""}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
