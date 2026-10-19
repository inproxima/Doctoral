/* Doctoral Examination SPA — no framework, no bundler, no CDN. */

const $ = (sel) => document.querySelector(sel);

const state = {
  runId: null,
  meta: null,
  artifacts: {},
  config: null,
  mode: "dissertation",
  tab: "1",
  events: null,
  units: {},
};

// The mode decides how many chapters exist, so nothing below may assume six.
const mode = () => state.config?.modes?.[state.mode] || { chapters: [], descriptions: {} };
const chapters = () => mode().chapters;
const chapterInfo = (n) => mode().descriptions?.[n] || {};
const noun = () => (mode().label || "document").toLowerCase();

/** Tabs that follow the chapters. Labels vary with the mode, so this is a function. */
const tailTabs = () => [
  ["summary", `📑 ${mode().label || "Document"} Summary`],
  ["final", "📝 Final Review"],
  ["oral", `🗣️ ${mode().oralTabLabel || "Oral Defence"}`],
  ["supervisor", "🧑‍🏫 Supervisor Feedback"],
  ["revision", "🔁 Revision"],
  ["analytics", "📈 Analytics"],
];

// ---------- tiny markdown renderer (offline, no dependency) ----------

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

function markdown(src) {
  if (!src) return '<p class="muted">Not generated yet.</p>';
  const lines = String(src).split("\n");
  const out = [];
  let i = 0;

  const isTableSep = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // table
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = (l) =>
        l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        body.push(cells(lines[i]));
        i += 1;
      }
      out.push(
        `<div class="table-wrap"><table class="md-table"><thead><tr>${head
          .map((c) => `<th>${inline(c)}</th>`)
          .join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i += 1;
      }
      out.push(
        `<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${
          ordered ? "ol" : "ul"
        }>`,
      );
      continue;
    }

    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*([-*+]|\d+\.)\s)/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

// ---------- api ----------

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

let toastTimer;
function toast(message, kind = "info") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4500);
}

// ---------- rendering ----------

/**
 * Download links for one artifact. The server renders the Word and PDF files from the saved
 * Markdown, so what is downloaded is always the artifact on disk, not whatever the page shows.
 */
function exportLinks(key) {
  const base = `/api/runs/${state.runId}/export/${key}`;
  return `<span class="export-links">
    <a class="btn ghost small-btn" href="${base}.docx" download title="Download as a Word document">Word</a>
    <a class="btn ghost small-btn" href="${base}.pdf" download title="Download as a PDF">PDF</a>
    <a class="btn ghost small-btn" href="${base}.md" download title="Download the Markdown source">MD</a>
  </span>`;
}

function artifactBlock(title, content, { exportKey, actions = "" } = {}) {
  const has = Boolean(content && String(content).trim());
  return `
    <div class="card">
      <div class="card-head">
        <h3>${esc(title)}</h3>
        <span class="card-actions">
          ${actions}
          ${has && exportKey && state.runId ? exportLinks(exportKey) : ""}
        </span>
      </div>
      <div class="md">${markdown(content)}</div>
    </div>`;
}

function chapterPanel(n) {
  const a = state.artifacts;
  const info = state.meta?.chapters?.[n];
  const text = a.chapters?.[n] || "";
  const { name = "", icon = "" } = chapterInfo(n);

  const priorCoverage = chapters()
    .filter((k) => k < n && a.coverage?.[k]?.trim())
    .map((k) => `Chapter ${k}\n${a.coverage[k].trim()}`)
    .join("\n\n");
  const priorLedger = chapters()
    .filter((k) => k < n && a.ledger?.[k]?.trim())
    .map((k) => `From Chapter ${k}\n${a.ledger[k].trim()}`)
    .join("\n\n");

  return `
    <h2>${icon} Chapter ${n} — ${esc(name)}</h2>
    ${
      info
        ? `<p class="muted small">Source <code>${esc(info.filename)}</code>${
            info.heading ? ` · from the heading “${esc(info.heading)}”` : ""
          }${info.pages ? ` · ${pageRange(info.pages)}` : ""} · ${info.words.toLocaleString()} words</p>`
        : `<p class="warn">No text loaded for this chapter. Upload the complete ${esc(noun())}, or a file named <code>chapter_${n}.pdf</code>, or paste text below.</p>`
    }

    <details class="pane">
      <summary>📄 Extracted text preview</summary>
      <textarea class="preview" id="paste-${n}" rows="10" placeholder="Paste chapter text here to set it manually…">${esc(text)}</textarea>
      <button class="btn small-btn" data-save-chapter="${n}">Save this text as Chapter ${n}</button>
    </details>

    ${
      n > 1 && (priorCoverage || priorLedger)
        ? `<details class="pane">
            <summary>📎 Carried forward from earlier chapters</summary>
            ${priorCoverage ? `<h4>Criteria already covered</h4><pre>${esc(priorCoverage)}</pre>` : ""}
            ${priorLedger ? `<h4>Issues already raised</h4><pre>${esc(priorLedger)}</pre>` : ""}
          </details>`
        : ""
    }

    ${artifactBlock("📋 Evaluation Criteria", a.criteria?.[n], {
      exportKey: `criteria-${n}`,
      actions: `<button class="btn ghost small-btn" data-regen="criteria" data-n="${n}">Regenerate</button>`,
    })}
    ${artifactBlock("🔍 Chapter Review", a.reviews?.[n], {
      exportKey: `review-${n}`,
      actions: `<button class="btn ghost small-btn" data-regen="review" data-n="${n}">Regenerate</button>`,
    })}`;
}

function summaryPanel() {
  return `
    <h2>📑 ${esc(mode().label)} Summary</h2>
    <p class="muted small">Generated from the full ${esc(noun())} at the start of the examination, independent of the review cascade.</p>
    ${artifactBlock(`📑 ${mode().label} Summary`, state.artifacts.summary, {
      exportKey: "summary",
    })}`;
}

function finalPanel() {
  const a = state.artifacts;
  return `
    <h2>📝 Final Review &amp; Decision</h2>
    <p class="muted small">Produced automatically at the end of the cascade, after every chapter review and the merged issue ledger.</p>
    ${
      state.runId && (a.finalReview || a.reviews?.[chapters()[0]])
        ? `<div class="row">
            <a class="btn primary" href="/api/runs/${state.runId}/export/package.docx" download>📦 Complete package · Word</a>
            <a class="btn" href="/api/runs/${state.runId}/export/package.pdf" download>📦 Complete package · PDF</a>
            <a class="btn ghost" href="/api/runs/${state.runId}/package">Plain text</a>
          </div>`
        : ""
    }
    ${artifactBlock("🧭 Final Comprehensive Review", a.finalReview, { exportKey: "finalReview" })}
    ${artifactBlock("✉️ Decision Letter", a.decisionLetter, { exportKey: "decisionLetter" })}`;
}

function supervisorPanel() {
  return `
    <h2>🧑‍🏫 Supervisor Feedback</h2>
    <p class="muted small">A private examiner briefing for the supervisor. What the examiner saw, and what should be communicated to the student, ranked from critical to minor with direct quotations as evidence.</p>
    ${artifactBlock("🧑‍🏫 Supervisor Feedback Brief", state.artifacts.supervisorFeedback, {
      exportKey: "supervisorFeedback",
    })}`;
}

function oralPanel() {
  const a = state.artifacts;
  return `
    <h2>🗣️ ${esc(mode().oralHeading || "Oral Defence Questions")}</h2>
    ${artifactBlock("🌐 Overarching Defence Questions", a.overallOral, {
      exportKey: "overallOral",
    })}
    ${chapters()
      .map((n) =>
        artifactBlock(`${chapterInfo(n).icon || ""} Chapter ${n} Questions`, a.oral?.[n], {
          exportKey: `oral-${n}`,
          actions: `<button class="btn ghost small-btn" data-regen="oral" data-n="${n}">Regenerate</button>`,
        }),
      )
      .join("")}`;
}

function revisionPanel() {
  const a = state.artifacts;
  return `
    <h2>🔁 Revision Review</h2>
    <p class="muted small">Upload the revised ${esc(noun())} and the candidate's response letter to assess whether the required changes were made.</p>
    <div class="row">
      <label class="btn file-btn">Revised ${esc(noun())}<input type="file" id="revised-file" hidden accept=".pdf,.docx,.txt,.md"></label>
      <label class="btn file-btn">Response letter<input type="file" id="response-file" hidden accept=".pdf,.docx,.txt,.md"></label>
      <button class="btn" id="btn-upload-revision">Upload</button>
    </div>
    <p class="muted small" id="revision-status">
      ${a.revisedText ? `✅ Revised ${esc(noun())} loaded.` : `⬜️ No revised ${esc(noun())}.`}
      ${a.responseText ? " ✅ Response letter loaded." : " ⬜️ No response letter."}
    </p>
    <div class="row">
      <button class="btn primary" data-revision="assessment">Assess revised ${esc(noun())}</button>
      <button class="btn" data-revision="response">Evaluate candidate response</button>
    </div>
    ${artifactBlock(`🧭 Revised ${mode().label} Assessment`, a.revisedAssessment, {
      exportKey: "revisedAssessment",
    })}
    ${artifactBlock("📊 Candidate Response Adequacy", a.responseEvaluation, {
      exportKey: "responseEvaluation",
    })}`;
}

async function analyticsPanel() {
  if (!state.runId) return "<h2>📈 Analytics</h2><p class=\"muted\">Start an examination first.</p>";
  const d = await api(`/api/runs/${state.runId}/analytics`);

  const sevClass = (s) => `sev-${String(s).trim().toLowerCase().replace(/[^a-z]/g, "")}`;
  const ledgerRows = d.ledger
    .map(
      (r) => `<tr>
        <td><code>${esc(r.id)}</code></td>
        <td>${r.raisedIn}</td>
        <td>${r.recursIn.length ? r.recursIn.join(", ") : "—"}</td>
        <td><span class="pill ${sevClass(r.severity)}">${esc(r.severity)}</span></td>
        <td>${esc(r.theme)}</td>
        <td>${esc(r.issue)}</td>
      </tr>`,
    )
    .join("");

  const unitRows = Object.entries(d.units)
    .map(
      ([name, u]) =>
        `<tr><td><code>${esc(name)}</code></td><td>${esc(u.status)}</td><td>${
          u.ms ? `${(u.ms / 1000).toFixed(1)}s` : "—"
        }</td><td class="muted small">${esc(u.error || "")}</td></tr>`,
    )
    .join("");

  const c = d.concurrency;
  return `
    <h2>📈 Examination Analytics</h2>

    <div class="metrics">
      <div class="metric"><span>Chapters loaded</span><strong>${d.chaptersLoaded} / ${
        d.chapterCount ?? chapters().length
      }</strong></div>
      <div class="metric"><span>Total words</span><strong>${d.totalWords.toLocaleString()}</strong></div>
      <div class="metric"><span>Distinct issues</span><strong>${d.ledger.length}</strong></div>
      <div class="metric"><span>Restatements avoided</span><strong>${d.restatementsAvoided}</strong></div>
      ${
        c
          ? `<div class="metric"><span>Peak parallel calls</span><strong>${c.peakInFlight} / ${c.cap}</strong></div>
             <div class="metric"><span>Model calls</span><strong>${c.modelCalls}</strong></div>`
          : ""
      }
      ${
        d.elapsedMs
          ? `<div class="metric"><span>Wall clock</span><strong>${(d.elapsedMs / 1000).toFixed(0)}s</strong></div>`
          : ""
      }
    </div>

    <h3>Duplication Ledger</h3>
    <p class="muted small">Every issue raised once, plus the chapters that referenced it again instead of restating it. This is the cascade doing its job.</p>
    ${
      ledgerRows
        ? `<div class="table-wrap"><table class="md-table">
            <thead><tr><th>ID</th><th>Raised in</th><th>Recurs in</th><th>Severity</th><th>Theme</th><th>Issue</th></tr></thead>
            <tbody>${ledgerRows}</tbody></table></div>`
        : '<p class="muted">No chapter reviews generated yet.</p>'
    }

    <h3>Unit Timing</h3>
    <div class="table-wrap"><table class="md-table">
      <thead><tr><th>Unit</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
      <tbody>${unitRows || '<tr><td colspan="4" class="muted">Nothing run yet.</td></tr>'}</tbody>
    </table></div>

    ${
      d.errors.length
        ? `<h3>Failures</h3><ul>${d.errors
            .map((e) => `<li><code>${esc(e.unit)}</code> ${esc(e.error)}</li>`)
            .join("")}</ul>`
        : ""
    }`;
}

async function render() {
  renderModeChrome();
  renderTabs();

  const panels = $("#panels");
  const t = state.tab;
  if (t === "summary") panels.innerHTML = summaryPanel();
  else if (t === "final") panels.innerHTML = finalPanel();
  else if (t === "oral") panels.innerHTML = oralPanel();
  else if (t === "supervisor") panels.innerHTML = supervisorPanel();
  else if (t === "revision") panels.innerHTML = revisionPanel();
  else if (t === "analytics") panels.innerHTML = await analyticsPanel();
  else panels.innerHTML = chapterPanel(Number(t));

  renderChapterTable();
  renderUploads();
}

/**
 * The chapter tabs are drawn from the mode, so switching to a proposal drops chapters
 * 4 to 6 rather than leaving dead buttons behind. A tab the new mode does not have
 * falls back to chapter 1.
 */
function renderTabs() {
  const tabs = [
    ...chapters().map((n) => [String(n), `${chapterInfo(n).icon || ""} Ch ${n}`]),
    ...tailTabs(),
  ];
  if (!tabs.some(([id]) => id === state.tab)) state.tab = "1";

  $("#tabs").innerHTML = tabs
    .map(
      ([id, label]) =>
        `<button data-tab="${id}"${id === state.tab ? ' class="active"' : ""}>${label}</button>`,
    )
    .join("");
}

/** Mode-dependent chrome: heading, footer, the title field label, and the file hint. */
function renderModeChrome() {
  const m = mode();
  const heading = m.heading || "Doctoral Examination";
  document.title = heading;
  $("#app-heading").textContent = `🎓 ${heading}`;
  $("#footer-heading").textContent = `${heading} Assistant`;
  $("#title-label").textContent = `${m.label} Title`;
  $("#mode-hint").textContent = `${m.chapters.length} chapters. The mode is fixed once chapter files are loaded.`;
  const last = m.chapters[m.chapters.length - 1];
  $("#files-hint").innerHTML =
    `Upload the complete ${esc(noun())} as one PDF or DOCX, title page, references and appendices ` +
    `included. Chapters 1 to ${last} are found and loaded automatically, and everything else is left out. ` +
    `Separate files named <code>chapter_1.pdf</code> to <code>chapter_${last}.pdf</code> also work.`;

  const select = $("#mode");
  select.value = state.mode;
  // Artifacts on disk are keyed to the chapter set they were generated under, so the
  // choice locks as soon as the run has any chapter text.
  select.disabled = Object.keys(state.meta?.chapters || {}).length > 0;
}

function renderChapterTable() {
  const tbody = $("#chapter-table tbody");
  tbody.innerHTML = chapters().map((n) => {
    const info = state.meta?.chapters?.[n];
    const label = esc(info?.filename || "—");
    return `<tr class="${info ? "" : "missing"}">
      <td>${n}</td>
      <td class="ellipsis" title="${esc(
        [info?.filename, info?.heading, info?.pages && pageRange(info.pages)].filter(Boolean).join(" · "),
      )}">${
        info?.uploadId
          ? `<a href="/api/runs/${state.runId}/uploads/${info.uploadId}">${label}</a>`
          : label
      }</td>
      <td>${info ? info.words.toLocaleString() : "—"}</td>
    </tr>`;
  }).join("");
}

// ---------- uploaded originals ----------

const bytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

const pageRange = (p) => (p[0] === p[1] ? `p. ${p[0]}` : `pp. ${p[0]} to ${p[1]}`);

const count = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * What one uploaded file turned into. A complete document gets the full account of its
 * split: each chapter with the heading it was found at, what was left out, and anything
 * the examination expected and did not find, so a wrong split is caught before it costs
 * an examination.
 */
function uploadReport(r) {
  if (r.kind !== "document") {
    return `<div class="upload-report">${r.error ? "❌" : "✅"} ${esc(r.filename)} → Chapter ${r.chapter}${
      r.error ? ` <span class="warn">${esc(r.error)}</span>` : ` · ${count(r.words, "word")}`
    }</div>`;
  }
  if (r.error) return `<div class="upload-report">❌ ${esc(r.filename)} <span class="warn">${esc(r.error)}</span></div>`;

  const s = r.split || {};
  const chaptersFound = s.chapters || [];
  if (chaptersFound.length === 0 && !(s.outside || []).length) {
    return `<div class="upload-report">⚠️ ${esc(r.filename)}
      <p class="warn small">No chapter headings were found in this file, so nothing was loaded. Upload one file per chapter named <code>chapter_1.pdf</code> and so on, or paste each chapter on its tab.</p></div>`;
  }

  const left = [
    s.frontMatter?.words ? `front matter (${count(s.frontMatter.words, "word")})` : "",
    ...(s.backMatter || []).map((b) => `${esc(b.heading)} (${count(b.words, "word")})`),
  ].filter(Boolean);

  return `<div class="upload-report">
    <div>${chaptersFound.length ? "✅" : "⚠️"} <strong>${esc(r.filename)}</strong> · ${count(chaptersFound.length, "chapter")} loaded</div>
    <ul class="split-list">${chaptersFound
      .map(
        (c) => `<li><span class="split-n">Ch ${c.n}</span> <span>${esc(c.heading)}</span>
          <span class="muted">${c.pages ? `${pageRange(c.pages)} · ` : ""}${count(c.words, "word")}</span></li>`,
      )
      .join("")}</ul>
    ${left.length ? `<p class="muted small">Left out: ${left.join(", ")}.</p>` : ""}
    ${
      s.method === "named-headings"
        ? '<p class="warn small">This document numbers no chapters in its text, so they were identified from their titles. Check each chapter tab before running.</p>'
        : ""
    }
    ${
      (s.outside || []).length
        ? `<p class="warn small">${s.outside.map((c) => `Chapter ${c.n}`).join(", ")} ${
            s.outside.length === 1 ? "is" : "are"
          } in the document, but a ${esc(noun())} examination covers chapters ${chapters()[0]} to ${
            chapters()[chapters().length - 1]
          }, so ${s.outside.length === 1 ? "it was" : "they were"} not loaded. To examine ${
            s.outside.length === 1 ? "it" : "them"
          }, start a new examination in the other mode.</p>`
        : ""
    }
    ${
      (s.missing || []).length === 1
        ? `<p class="warn small">Chapter ${s.missing[0]} was not found. Upload it as <code>chapter_${s.missing[0]}.pdf</code> or paste the text on its tab.</p>`
        : (s.missing || []).length > 1
          ? `<p class="warn small">Chapters ${s.missing.join(", ")} were not found. Upload each as its own file, for example <code>chapter_${s.missing[0]}.pdf</code>, or paste the text on its tab.</p>`
          : ""
    }
  </div>`;
}

const uploadTag = (u) => {
  if (u.kind === "revised") return `Revised ${noun()}`;
  if (u.kind === "response") return "Response letter";
  if (u.kind === "document") {
    const found = (u.split?.chapters || []).map((c) => c.n);
    if (found.length === 0) return "Complete document, no chapters found";
    return `Complete document → ${found.length === 1 ? "Chapter" : "Chapters"} ${found.join(", ")}`;
  }
  return u.chapter ? `Chapter ${u.chapter}` : "Unassigned";
};

function renderUploads() {
  const list = $("#upload-list");
  const uploads = state.meta?.uploads || [];

  $("#btn-delete-uploads").classList.toggle("hidden", uploads.length === 0);
  $("#uploads-total").textContent = uploads.length
    ? `· ${uploads.length} file${uploads.length === 1 ? "" : "s"}, ${bytes(
        uploads.reduce((s, u) => s + u.bytes, 0),
      )}`
    : "";

  if (uploads.length === 0) {
    list.innerHTML = '<li class="muted small">No original files stored for this run.</li>';
    return;
  }

  // Newest first, which is the order they are most likely to be looked for in.
  list.innerHTML = [...uploads]
    .reverse()
    .map(
      (u) => `<li>
        <a href="/api/runs/${state.runId}/uploads/${u.id}" title="Download the original file">${esc(u.filename)}</a>
        <span class="muted small">${u.error ? "⚠️ " : ""}${esc(uploadTag(u))} · ${bytes(u.bytes)}</span>
        <button class="icon-btn" data-del-upload="${u.id}" title="Delete this original file">✕</button>
      </li>`,
    )
    .join("");
}

// ---------- run lifecycle ----------

async function loadRun(id) {
  state.runId = id;
  const { meta, artifacts } = await api(`/api/runs/${id}`);
  state.meta = meta;
  state.artifacts = artifacts;
  state.units = meta.units || {};
  state.mode = meta.mode || state.config.defaultMode;
  $("#title").value = meta.title || "";
  $("#concerns").value = meta.chairConcerns || "";
  connectEvents(id);
  await render();
  renderUnits();
}

async function ensureRun() {
  if (state.runId) {
    await api(`/api/runs/${state.runId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: $("#title").value, chairConcerns: $("#concerns").value }),
    });
    return state.runId;
  }
  const meta = await api("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: $("#title").value,
      chairConcerns: $("#concerns").value,
      mode: state.mode,
    }),
  });
  state.runId = meta.id;
  state.meta = meta;
  connectEvents(meta.id);
  await refreshRunList();
  $("#run-select").value = meta.id;
  return meta.id;
}

const UNIT_LABEL = (u) => {
  const [kind, n] = u.split(":");
  const label = { criteria: "Criteria", review: "Review", oral: "Oral questions" }[kind];
  if (n) return `Ch ${n} · ${label}`;
  return {
    summary: `${mode().label} summary`,
    overallOral: "Overarching oral questions",
    finalReview: "Final comprehensive review",
    decisionLetter: "Decision letter",
    supervisorFeedback: "Supervisor feedback brief",
  }[u] || u;
};

const allUnits = () => [
  ...chapters().flatMap((n) => [`criteria:${n}`, `review:${n}`, `oral:${n}`]),
  "summary",
  "overallOral",
  "finalReview",
  "decisionLetter",
  "supervisorFeedback",
];

function renderUnits() {
  const panel = $("#progress-panel");
  const entries = Object.entries(state.units);
  if (entries.length === 0) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const units = allUnits();
  const settled = units.filter((u) =>
    ["done", "skipped", "failed"].includes(state.units[u]?.status),
  ).length;
  const pct = Math.round((settled / units.length) * 100);
  $("#bar-fill").style.width = `${pct}%`;
  $("#progress-count").textContent = `${settled} / ${units.length}`;

  const icon = { running: "◐", done: "✅", skipped: "⏭", failed: "❌" };
  $("#unit-list").innerHTML = units.map((u) => {
    const s = state.units[u]?.status;
    if (!s) return "";
    return `<li class="u-${s}"><span>${icon[s] || "·"}</span> ${esc(UNIT_LABEL(u))}${
      state.units[u]?.ms ? ` <span class="muted small">${(state.units[u].ms / 1000).toFixed(0)}s</span>` : ""
    }</li>`;
  }).join("");
}

function connectEvents(id) {
  state.events?.close();
  const es = new EventSource(`/api/runs/${id}/events`);
  state.events = es;

  es.onmessage = async (ev) => {
    const e = JSON.parse(ev.data);

    if (e.type === "run:start") {
      state.units = {};
      $("#progress-label").textContent = "Examination running…";
    } else if (e.type === "unit:start") {
      state.units[e.unit] = { status: "running" };
      $("#progress-label").textContent = `Running ${UNIT_LABEL(e.unit)}…`;
    } else if (e.type === "unit:done") {
      state.units[e.unit] = { status: "done", ms: e.ms };
    } else if (e.type === "unit:skipped") {
      state.units[e.unit] = { status: "skipped" };
    } else if (e.type === "unit:failed") {
      state.units[e.unit] = { status: "failed", error: e.error };
      toast(`${UNIT_LABEL(e.unit)} failed: ${e.error}`, "error");
    } else if (e.type === "artifact") {
      const { artifacts } = await api(`/api/runs/${id}`);
      state.artifacts = artifacts;
      await render();
    } else if (e.type === "run:done") {
      $("#progress-label").textContent =
        e.status === "done" ? "Examination complete." : "Complete, with errors.";
      $("#btn-examine").disabled = false;
      toast(
        `Finished in ${(e.elapsedMs / 1000).toFixed(0)}s · ${e.modelCalls} model calls · peak ${e.peakInFlight} in parallel`,
        e.status === "done" ? "ok" : "warn",
      );
      const { meta, artifacts } = await api(`/api/runs/${id}`);
      state.meta = meta;
      state.artifacts = artifacts;
      await render();
    } else if (e.type === "run:error") {
      $("#btn-examine").disabled = false;
      toast(e.error, "error");
    }
    renderUnits();
  };
}

async function refreshRunList() {
  const runs = await api("/api/runs");
  $("#run-select").innerHTML =
    '<option value="">— new examination —</option>' +
    runs
      .map(
        (r) =>
          `<option value="${r.id}">${esc(r.title || "(untitled)")} · ${r.createdAt.slice(0, 16).replace("T", " ")}</option>`,
      )
      .join("");
}

// ---------- events ----------

$("#tabs").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  [...$("#tabs").children].forEach((b) => b.classList.toggle("active", b === btn));
  state.tab = btn.dataset.tab;
  await render();
});

$("#files").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const id = await ensureRun();
  $("#file-status").textContent = "Extracting…";

  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  try {
    const { results, meta } = await api(`/api/runs/${id}/files`, { method: "POST", body: fd });
    state.meta = meta;
    state.artifacts = (await api(`/api/runs/${id}`)).artifacts;
    $("#file-status").innerHTML = results.map(uploadReport).join("");
    await render();
  } catch (err) {
    $("#file-status").textContent = "";
    toast(err.message, "error");
  }
  e.target.value = "";
});

$("#upload-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-upload]");
  if (!del) return;
  const record = (state.meta?.uploads || []).find((u) => u.id === del.dataset.delUpload);
  if (!record) return;
  if (!confirm(`Delete the original file "${record.filename}"?\n\nThe extracted text and every generated artifact stay as they are.`))
    return;
  try {
    const { meta } = await api(`/api/runs/${state.runId}/uploads/${record.id}`, { method: "DELETE" });
    state.meta = meta;
    renderChapterTable();
    renderUploads();
    toast(`Deleted ${record.filename}.`, "ok");
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#btn-delete-uploads").addEventListener("click", async () => {
  const count = (state.meta?.uploads || []).length;
  if (!count) return;
  if (!confirm(`Delete all ${count} original file${count === 1 ? "" : "s"} for this run?\n\nThe extracted text and every generated artifact stay as they are.`))
    return;
  try {
    const { meta, deleted } = await api(`/api/runs/${state.runId}/uploads`, { method: "DELETE" });
    state.meta = meta;
    renderChapterTable();
    renderUploads();
    toast(`Deleted ${deleted} original file${deleted === 1 ? "" : "s"}.`, "ok");
  } catch (err) {
    toast(err.message, "error");
  }
});

$("#btn-examine").addEventListener("click", async () => {
  try {
    const id = await ensureRun();
    $("#btn-examine").disabled = true;
    state.units = {};
    renderUnits();
    await api(`/api/runs/${id}/examine`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: $("#force").checked }),
    });
    $("#progress-panel").classList.remove("hidden");
    $("#progress-label").textContent = "Examination running…";
  } catch (err) {
    $("#btn-examine").disabled = false;
    toast(err.message, "error");
  }
});

$("#btn-new-run").addEventListener("click", async () => {
  state.runId = null;
  state.meta = null;
  state.artifacts = {};
  state.units = {};
  state.mode = state.config.defaultMode;
  state.events?.close();
  $("#title").value = "";
  $("#concerns").value = "";
  $("#file-status").textContent = "";
  $("#run-select").value = "";
  $("#progress-panel").classList.add("hidden");
  await render();
});

$("#run-select").addEventListener("change", async (e) => {
  if (!e.target.value) return;
  await loadRun(e.target.value);
});

$("#mode").addEventListener("change", async (e) => {
  const previous = state.mode;
  state.mode = e.target.value;
  try {
    // A run only exists this early if the user typed a title first, so this is a cheap
    // patch. Once chapter text is loaded the select is disabled and this never fires.
    if (state.runId) {
      state.meta = await api(`/api/runs/${state.runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: state.mode }),
      });
    }
    await render();
  } catch (err) {
    state.mode = previous;
    await render();
    toast(err.message, "error");
  }
});

$("#btn-test").addEventListener("click", async () => {
  toast("Testing…");
  const r = await api("/api/test-model", { method: "POST" });
  toast(r.ok ? `${r.model} replied "${r.reply}"` : `Failed: ${r.error}`, r.ok ? "ok" : "error");
});

for (const el of [$("#title"), $("#concerns")]) {
  el.addEventListener("blur", async () => {
    if (state.runId) await ensureRun();
  });
}

$("#panels").addEventListener("click", async (e) => {
  const regen = e.target.closest("[data-regen]");
  if (regen) {
    const { regen: kind, n } = regen.dataset;
    regen.disabled = true;
    regen.textContent = "Working…";
    try {
      await api(`/api/runs/${state.runId}/chapters/${n}/${kind}`, { method: "POST" });
      state.artifacts = (await api(`/api/runs/${state.runId}`)).artifacts;
      await render();
      toast("Regenerated.", "ok");
    } catch (err) {
      toast(err.message, "error");
      regen.disabled = false;
      regen.textContent = "Regenerate";
    }
    return;
  }

  const save = e.target.closest("[data-save-chapter]");
  if (save) {
    const n = save.dataset.saveChapter;
    const text = $(`#paste-${n}`).value.trim();
    if (!text) return toast("Nothing to save.", "error");
    const id = await ensureRun();
    await api(`/api/runs/${id}/chapters/${n}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    state.meta = (await api(`/api/runs/${id}`)).meta;
    toast(`Chapter ${n} saved. Derived artifacts cleared.`, "ok");
    await render();
    return;
  }

  const rev = e.target.closest("[data-revision]");
  if (rev) {
    rev.disabled = true;
    const original = rev.textContent;
    rev.textContent = "Working…";
    try {
      await api(`/api/runs/${state.runId}/revision/${rev.dataset.revision}`, { method: "POST" });
      state.artifacts = (await api(`/api/runs/${state.runId}`)).artifacts;
      await render();
      toast("Done.", "ok");
    } catch (err) {
      toast(err.message, "error");
      rev.disabled = false;
      rev.textContent = original;
    }
    return;
  }

  const up = e.target.closest("#btn-upload-revision");
  if (up) {
    const fd = new FormData();
    const rf = $("#revised-file").files[0];
    const pf = $("#response-file").files[0];
    if (!rf && !pf) return toast("Choose a file first.", "error");
    if (rf) fd.append("revised", rf);
    if (pf) fd.append("response", pf);
    const id = await ensureRun();
    await api(`/api/runs/${id}/revision`, { method: "POST", body: fd });
    const refreshed = await api(`/api/runs/${id}`);
    state.meta = refreshed.meta;
    state.artifacts = refreshed.artifacts;
    await render();
    toast("Uploaded.", "ok");
    return;
  }
});

// ---------- boot ----------

(async () => {
  state.config = await api("/api/config");
  state.mode = state.config.defaultMode;
  $("#mode").innerHTML = Object.values(state.config.modes)
    .map((m) => `<option value="${m.id}">${esc(m.optionLabel)}</option>`)
    .join("");
  const badge = `${state.config.model} · reasoning ${state.config.reasoningEffort}`;
  $("#model-badge").textContent = badge;
  $("#footer-model").textContent = `OpenAI ${badge}`;
  if (!state.config.hasKey) toast("OPENAI_API_KEY is not set in .env", "error");
  await refreshRunList();
  await render();
})();
