/**
 * Run persistence. Each examination is a folder under runs/<id>/ holding the
 * extracted chapter text and every generated artifact as a plain file.
 *
 * The Streamlit original kept all of this in st.session_state, so a refresh or a
 * crash discarded every completed API call. Writing each artifact the moment it
 * lands means a failure costs one call rather than the run, and lets the pipeline
 * resume by skipping whatever is already on disk.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { DEFAULT_MODE, getMode } from "./modes.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUNS_DIR = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.join(ROOT, "runs");

export const ARTIFACT_FILES = {
  criteria: (n) => `criteria/${n}.md`,
  coverage: (n) => `coverage/${n}.txt`,
  review: (n) => `reviews/${n}.md`,
  ledger: (n) => `ledger/${n}.txt`,
  oral: (n) => `oral/${n}.md`,
  chapter: (n) => `chapters/${n}.txt`,
};

export const SINGLETON_FILES = {
  summary: "summary.md",
  overallOral: "overall_oral_questions.md",
  finalReview: "final_review.md",
  decisionLetter: "decision_letter.md",
  supervisorFeedback: "supervisor_feedback.md",
  revisedAssessment: "revised_assessment.md",
  responseEvaluation: "response_evaluation.md",
  revisedText: "revised_dissertation.txt",
  responseText: "candidate_response.txt",
};

/** Originals live alongside the artifacts, in their own folder, untouched by the cascade. */
export const UPLOADS_DIR = "uploads";

/** Append-only JSONL record of every progress event, one line per event. */
export const EVENTS_LOG = "events.log";

const runDir = (id) => path.join(RUNS_DIR, id);

function assertSafeId(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id || "")) throw new Error(`Invalid run id: ${id}`);
  return id;
}

/** Write via a temp file then rename, so a crash never leaves a half-written artifact. */
async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, data); // strings default to utf8, buffers are written verbatim
  await fs.rename(tmp, file);
}

export async function createRun({ title, chairConcerns, mode, model, reasoningEffort }) {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${crypto
    .randomBytes(3)
    .toString("hex")}`;
  const meta = {
    id,
    title: title || "",
    chairConcerns: chairConcerns || "",
    mode: getMode(mode).id,
    model,
    reasoningEffort,
    createdAt: new Date().toISOString(),
    files: {},
    chapters: {},
    uploads: [],
    units: {},
    status: "created",
  };
  await writeMeta(id, meta);
  return meta;
}

export async function listRuns() {
  await fs.mkdir(RUNS_DIR, { recursive: true });
  const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  const runs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await readMeta(e.name).catch(() => null);
    if (meta) runs.push(meta);
  }
  return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function readMeta(id) {
  const raw = await fs.readFile(path.join(runDir(assertSafeId(id)), "meta.json"), "utf8");
  const meta = JSON.parse(raw);
  // Runs written before modes existed have no mode. They were all dissertations.
  meta.mode = meta.mode || DEFAULT_MODE;
  return meta;
}

export async function writeMeta(id, meta) {
  await atomicWrite(path.join(runDir(assertSafeId(id)), "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

/** Read-modify-write serialized per run, so concurrent pipeline units cannot clobber each other. */
const metaLocks = new Map();
export function updateMeta(id, mutate) {
  const prev = metaLocks.get(id) || Promise.resolve();
  const next = prev.then(async () => {
    const meta = await readMeta(id);
    await mutate(meta);
    return writeMeta(id, meta);
  });
  metaLocks.set(
    id,
    next.catch(() => {}),
  );
  return next;
}

/**
 * Append one progress event to runs/<id>/events.log.
 *
 * meta.json keeps only the final state of each unit; a failure that was retried, or one
 * the browser missed because no tab was open, leaves no trace there. This log is the
 * replayable history: every event the SSE stream carried, in order, with a timestamp.
 * Writes are serialized per run so concurrent units cannot interleave a line.
 */
const eventLocks = new Map();
export function appendEvent(id, event) {
  const prev = eventLocks.get(id) || Promise.resolve();
  const next = prev.then(async () => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    await fs.appendFile(path.join(runDir(assertSafeId(id)), EVENTS_LOG), `${line}\n`);
  });
  eventLocks.set(
    id,
    next.catch(() => {}),
  );
  return next;
}

export async function readEvents(id) {
  const raw = await readArtifact(id, EVENTS_LOG);
  if (raw === null) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { ts: null, type: "unparseable", line };
      }
    });
}

export async function writeArtifact(id, relPath, content) {
  await atomicWrite(path.join(runDir(assertSafeId(id)), relPath), content ?? "");
}

export async function readArtifact(id, relPath) {
  try {
    return await fs.readFile(path.join(runDir(assertSafeId(id)), relPath), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Load every artifact of a run into one object, for the API and the resume path.
 *
 * The chapter range comes from the run's own mode rather than a constant, so a
 * proposal never reports chapters it cannot have.
 */
export async function loadArtifacts(id) {
  const { chapters: chapterNumbers } = getMode((await readMeta(id)).mode);
  const out = { chapters: {}, criteria: {}, coverage: {}, reviews: {}, ledger: {}, oral: {} };
  const keyed = {
    chapters: ARTIFACT_FILES.chapter,
    criteria: ARTIFACT_FILES.criteria,
    coverage: ARTIFACT_FILES.coverage,
    reviews: ARTIFACT_FILES.review,
    ledger: ARTIFACT_FILES.ledger,
    oral: ARTIFACT_FILES.oral,
  };
  for (const [key, fileFor] of Object.entries(keyed)) {
    for (const n of chapterNumbers) {
      const content = await readArtifact(id, fileFor(n));
      if (content !== null) out[key][n] = content;
    }
  }
  for (const [key, file] of Object.entries(SINGLETON_FILES)) {
    const content = await readArtifact(id, file);
    if (content !== null) out[key] = content;
  }
  return out;
}

// ---------- uploaded originals ----------

/**
 * The extracted text is what the examiner reads, but it is not what the candidate sent.
 * Keeping the original PDF or DOCX means a bad extraction can be diagnosed against the
 * source, and the run stays reviewable long after the copy on the examiner's desktop is
 * gone. They are the candidate's own documents, so deleting them is always one click.
 */

/** Disk name is `<uploadId>__<sanitized>`, so the folder stays browsable and collision free. */
function storedName(uploadId, filename) {
  const base = path
    .basename(String(filename))
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-120);
  return `${uploadId}__${base || "upload"}`;
}

/** Resolve a stored file, refusing anything that would escape the run's uploads folder. */
export function uploadPath(id, storedAs) {
  const dir = path.join(runDir(assertSafeId(id)), UPLOADS_DIR);
  const file = path.resolve(dir, String(storedAs));
  if (path.dirname(file) !== path.resolve(dir)) throw new Error(`Invalid upload: ${storedAs}`);
  return file;
}

/**
 * kind is "chapter" for a file named for its chapter, "document" for a complete document
 * that was split (its split report is kept with it), or "revised" / "response".
 */
export async function saveUpload(id, { filename, buffer, kind, chapter = null, mimetype = "", error = null, split = null }) {
  const uploadId = crypto.randomBytes(8).toString("hex");
  const storedAs = storedName(uploadId, filename);
  await atomicWrite(uploadPath(id, storedAs), buffer);

  const record = {
    id: uploadId,
    filename,
    storedAs,
    kind,
    chapter,
    mimetype: mimetype || "application/octet-stream",
    bytes: buffer.length,
    error,
    ...(split ? { split } : {}),
    uploadedAt: new Date().toISOString(),
  };
  await updateMeta(id, (m) => {
    m.uploads = [...(m.uploads || []), record];
  });
  return record;
}

export async function findUpload(id, uploadId) {
  const meta = await readMeta(id);
  return (meta.uploads || []).find((u) => u.id === uploadId) || null;
}

/**
 * Deleting an original removes only that file. The extracted text and every generated
 * artifact are separate files and survive, so a deletion never costs a model call.
 */
export async function deleteUpload(id, uploadId) {
  const record = await findUpload(id, uploadId);
  if (!record) return null;
  await fs.rm(uploadPath(id, record.storedAs), { force: true });
  await updateMeta(id, (m) => {
    m.uploads = (m.uploads || []).filter((u) => u.id !== uploadId);
    for (const info of Object.values(m.chapters || {})) {
      if (info?.uploadId === uploadId) delete info.uploadId;
    }
  });
  return record;
}

export async function deleteAllUploads(id) {
  const meta = await readMeta(id);
  const count = (meta.uploads || []).length;
  await fs.rm(path.join(runDir(assertSafeId(id)), UPLOADS_DIR), { recursive: true, force: true });
  await updateMeta(id, (m) => {
    m.uploads = [];
    for (const info of Object.values(m.chapters || {})) delete info.uploadId;
  });
  return count;
}

/**
 * New chapter text invalidates every derived artifact. The Python original cleared
 * session_state for the same reason: a stale ledger carried into a new examination
 * would silently suppress genuine issues.
 */
export async function invalidateDerived(id) {
  const dir = runDir(assertSafeId(id));
  const targets = ["criteria", "coverage", "reviews", "ledger", "oral"];
  await Promise.all(
    targets.map((sub) => fs.rm(path.join(dir, sub), { recursive: true, force: true })),
  );
  await Promise.all(
    Object.values(SINGLETON_FILES)
      .filter((f) => !f.startsWith("revised_dissertation") && !f.startsWith("candidate_response"))
      .map((f) => fs.rm(path.join(dir, f), { force: true })),
  );
  await updateMeta(id, (meta) => {
    meta.units = {};
    meta.status = "created";
  });
}
