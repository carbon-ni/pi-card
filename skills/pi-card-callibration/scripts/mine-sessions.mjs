#!/usr/bin/env node
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
    if (!["--output", "--project", "--since", "--until", "--files", "--limit", "--consent"].includes(key)) {
      throw new Error(`Unknown option: ${key}`);
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    const name = key.slice(2);
    options[name] = ["output", "project", "since", "until", "consent"].includes(name) ? value : Number(value);
    if (name === "consent" && value !== "yes") throw new Error("Explicit consent is required before reading session JSONL");
    if ((name === "files" && (!Number.isInteger(options.files) || options.files < 1 || options.files > MAX_FILES)) ||
        (name === "limit" && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_CANDIDATES))) {
      throw new Error(`${key} must be between 1 and ${name === "files" ? MAX_FILES : MAX_CANDIDATES}`);
    }
  }
  if (options.consent !== "yes") throw new Error("Explicit consent is required before reading session JSONL");
  const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (!options.output || path.basename(options.output) !== options.output || [".", ".."].includes(options.output) || !options.project || !path.isAbsolute(options.project) || !validDate(options.since) || !validDate(options.until)) {
    throw new Error("Usage: mine-sessions.mjs --consent yes --project <absolute-cwd> --since YYYY-MM-DD --until YYYY-MM-DD --output <filename> [--files 1-5] [--limit 1-20]");
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

function redact(text) {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:sk|pk|api|token|key)[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_SECRET]")
    .replace(/\b(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/gi, "[REDACTED_SECRET]")
    .replace(/\b(?:\+?\d[\d ().-]{7,}\d)\b/g, "[REDACTED_PHONE]")
    .replaceAll(os.homedir(), "[HOME]");
}

async function mine({ files, limit, output, project, since, until }) {
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
    for (let index = 1; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let row;
      try { row = JSON.parse(lines[index]); }
      catch { throw new Error(`Malformed selected session JSONL (${path.basename(file)}:${index + 1}); no output written`); }
      if (row.type !== "message" || !["user", "assistant"].includes(row.message?.role)) continue;
      if (!timestampInRange(row.timestamp, earliest, latest)) continue;
      const text = textOf(row.message.content);
      if (text) messages.push({ role: row.message.role, text, id: `${path.basename(file)}:${index + 1}` });
    }
    for (let i = messages.length - 1; i >= 0 && results.length < limit; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      const previous = messages[i - 1];
      results.push({
        id: message.id,
        text: redact(message.text).slice(0, MAX_MESSAGE_CHARS).trim(),
        context: previous ? redact(previous.text).slice(-MAX_CONTEXT_CHARS).trim() : "",
        activeStatus: "unknown",
        label: null,
      });
    }
    if (results.length >= limit) break;
  }
  const result = { source: "local-pi-sessions", project: projectPath, dateRange: { since, until }, selectedSessionFiles: selected.length, candidates: results };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}

try {
  const result = await mine(parseArgs(process.argv.slice(2)));
  console.log(`Wrote ${result.candidates.length} redacted candidates from ${result.selectedSessionFiles} session files for the approved project/date range.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
