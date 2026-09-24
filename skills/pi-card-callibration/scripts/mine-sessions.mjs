#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const MAX_FILES = 5;
const MAX_CANDIDATES = 20;
const MAX_DISCOVERED_FILES = 2_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DEPTH = 4;
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

async function collectFiles(directory, root, depth = 0, found = []) {
  if (depth > MAX_DEPTH) return found;
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return found;
  const canonicalDirectory = await realpath(directory);
  const relativeDirectory = path.relative(root, canonicalDirectory);
  if (relativeDirectory.startsWith("..") || path.isAbsolute(relativeDirectory)) return found;
  const entries = await readdir(canonicalDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    // Dirent checks deliberately ignore symlinks, both for directories and files.
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(fullPath);
      if (found.length > MAX_DISCOVERED_FILES) throw new Error("Too many session files; narrow the selected sessions root");
    } else if (entry.isDirectory() && depth < MAX_DEPTH) {
      await collectFiles(fullPath, root, depth + 1, found);
    }
  }
  return found;
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
    const buffer = Buffer.alloc(16_384);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0) throw new Error("Header exceeds 16 KB");
    return JSON.parse(text.slice(0, newline));
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
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join(" ").trim();
}

function findAncestorContext(parentId, entriesById) {
  const visited = new Set();
  let currentId = parentId;
  for (let depth = 0; typeof currentId === "string" && depth < 1_000; depth++) {
    if (visited.has(currentId)) return "";
    visited.add(currentId);
    const ancestor = entriesById.get(currentId);
    if (!ancestor) return "";
    if (ancestor.message?.text) return ancestor.message.text;
    currentId = ancestor.parentId;
  }
  return "";
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
    const messageLabel = document.createElement("label");
    messageLabel.textContent = "User message";
    const message = document.createElement("textarea");
    message.value = review.text;
    message.rows = 4;
    messageLabel.append(message);
    card.append(messageLabel);
    const contextLabel = document.createElement("label");
    contextLabel.textContent = "Prior context (linked ancestor)";
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
    message.addEventListener("input", () => { review.text = message.value; });
    context.addEventListener("input", () => { review.context = context.value; });
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
body{font:16px/1.5 system-ui,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;color:#18212b;background:#f7f8fa}h1{font-size:1.7rem}article{background:white;border:1px solid #cbd2da;border-radius:8px;padding:1rem;margin:1rem 0}label{display:block;font-weight:600;margin:.8rem 0}textarea,select{display:block;box-sizing:border-box;width:100%;font:inherit;padding:.6rem;border:1px solid #8793a1;border-radius:4px}input[type=checkbox]{width:1.1rem;height:1.1rem}button{font:inherit;padding:.65rem 1rem;border:0;border-radius:4px;background:#123f70;color:white;cursor:pointer}#summary{font-weight:600;position:sticky;top:0;background:#f7f8fa;padding:.6rem 0}small{color:#414d59}
</style>
</head>
<body>
<h1>Local Pi Card calibration review</h1>
<p>This page is offline. Review and edit each redacted example, then label it. Nothing is sent anywhere and no Pi Card configuration is changed. Stop labels require a separate per-example confirmation.</p>
<p><small>Date range: ${result.dateRange.since} through ${result.dateRange.until} UTC. Delete this sensitive page after review.</small></p>
<p id="summary" aria-live="polite"></p>
<div id="candidate-list"></div>
<button id="download" type="button">Download reviewed labels JSON</button>
<script id="candidate-data" type="application/json">${jsonForHtml(result)}</script>
<script>${REVIEWER_SCRIPT}</script>
</body>
</html>
`;
}

async function mine({ files, html, limit, output, project, since, until }) {
  const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  const agentStat = await lstat(agentDir);
  if (agentStat.isSymbolicLink() || !agentStat.isDirectory()) throw new Error("Pi agent config directory must be a real directory, not a symlink");
  const canonicalAgentDir = await realpath(agentDir);
  const sessions = path.join(canonicalAgentDir, "sessions");
  const sessionsStat = await lstat(sessions);
  if (sessionsStat.isSymbolicLink() || !sessionsStat.isDirectory()) throw new Error("Pi sessions directory must be a real directory, not a symlink");
  const canonicalRoot = await realpath(sessions);
  if (canonicalRoot !== sessions) throw new Error("Pi sessions directory resolves outside the configured agent directory");
  const outputPath = path.join(canonicalAgentDir, output);
  const projectPath = await realpath(project);
  const earliest = Date.parse(`${since}T00:00:00Z`);
  const latest = Date.parse(`${until}T23:59:59.999Z`);
  const allFiles = await collectFiles(canonicalRoot, canonicalRoot);
  const eligible = [];
  for (const file of allFiles) {
    let canonicalFile;
    try { canonicalFile = await realpath(file); }
    catch { continue; }
    const relativeFile = path.relative(canonicalRoot, canonicalFile);
    if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) continue;
    const fileStat = await lstat(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) continue;
    let header;
    try { header = await readHeader(file); }
    catch { throw new Error(`Malformed or unreadable session header (${path.basename(file)}); no output written`); }
    const timestamp = Date.parse(header.timestamp);
    let headerProject;
    try { headerProject = await realpath(header.cwd); }
    catch { continue; }
    if (header.type === "session" && headerProject === projectPath && timestamp >= earliest && timestamp <= latest) {
      eligible.push({ file, timestamp });
    }
  }
  eligible.sort((a, b) => b.timestamp - a.timestamp || a.file.localeCompare(b.file));
  const selected = eligible.slice(0, files);
  const results = [];
  for (const { file } of selected) {
    let contents;
    try { contents = await readSession(file); }
    catch { throw new Error(`Oversized or unreadable selected session (${path.basename(file)}); no output written`); }
    const lines = contents.split("\n");
    const messages = [];
    const entriesById = new Map();
    const ambiguousIds = new Set();
    for (let index = 1; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let row;
      try { row = JSON.parse(lines[index]); }
      catch { throw new Error(`Malformed selected session JSONL (${path.basename(file)}:${index + 1}); no output written`); }
      const entry = { parentId: typeof row.parentId === "string" ? row.parentId : null, message: null };
      if (typeof row.id === "string" && !ambiguousIds.has(row.id)) {
        if (entriesById.has(row.id)) {
          entriesById.delete(row.id);
          ambiguousIds.add(row.id);
        } else {
          entriesById.set(row.id, entry);
        }
      }
      if (row.type !== "message" || !["user", "assistant"].includes(row.message?.role)) continue;
      if (!timestampInRange(row.timestamp, earliest, latest)) continue;
      const text = textOf(row.message.content);
      if (!text) continue;
      entry.message = { role: row.message.role, text };
      messages.push({ ...entry.message, parentId: entry.parentId, rowId: row.id, id: `${path.basename(file)}:${index + 1}` });
    }
    for (let i = messages.length - 1; i >= 0 && results.length < limit; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      const context = findAncestorContext(message.parentId, entriesById);
      results.push({
        id: message.id,
        text: redact(message.text).slice(0, MAX_MESSAGE_CHARS).trim(),
        context: context ? redact(context).slice(-MAX_CONTEXT_CHARS).trim() : "",
        activeStatus: "unknown",
        label: null,
      });
    }
    if (results.length >= limit) break;
  }
  const result = { source: "local-pi-sessions", project: "[REDACTED_PATH]", dateRange: { since, until, timeZone: "UTC" }, selectedSessionFiles: selected.length, candidates: results };
  if (html) await writeFile(path.join(canonicalAgentDir, html), renderReviewer(result), { flag: "wx", mode: 0o600 });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await mine(options);
  console.log(`Wrote ${result.candidates.length} redacted candidates from ${result.selectedSessionFiles} session files. Candidate JSON: ${options.output}${options.html ? `; local HTML reviewer: ${options.html}` : ""}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
