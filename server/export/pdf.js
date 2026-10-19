/**
 * PDF rendering through pdfmake, so the app still needs no browser, no LibreOffice and no
 * Python to produce a typeset document.
 *
 * The fonts are Adobe's Source Serif and Source Sans (SIL Open Font License), embedded from
 * their npm packages. They carry full Latin, Greek and Cyrillic, which a dissertation's
 * author names and statistics need and pdfmake's bundled Roboto subset does not promise.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { COLORS, DISCLAIMER, SEVERITY_COLORS, SIZES, sectionColor } from "./theme.js";
import { columnWeights, isFieldLabel, issueHeading, plain } from "./markdown.js";

const require = createRequire(import.meta.url);
const pdfmake = require("pdfmake");

const hex = (c) => `#${c}`;

const PAGE_WIDTH = 612; // US Letter, in points
const MARGIN_X = 72;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

/**
 * pdfmake on Node treats every font descriptor as a path or URL string, and rewrites the
 * descriptor object in place on each render, so a Buffer given directly survives exactly
 * one document. Each file is loaded once into pdfmake's virtual file system instead, and
 * the descriptors name it there.
 */
const fontsOf = (pkg, files) => {
  const dir = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), "TTF");
  for (const file of Object.values(files)) {
    if (!pdfmake.virtualfs.existsSync(file)) pdfmake.virtualfs.writeFileSync(file, fs.readFileSync(path.join(dir, file)));
  }
  return files;
};

pdfmake.setFonts({
  Serif: fontsOf("source-serif-pro", {
    normal: "SourceSerifPro-Regular.ttf",
    bold: "SourceSerifPro-Semibold.ttf",
    italics: "SourceSerifPro-It.ttf",
    bolditalics: "SourceSerifPro-SemiboldIt.ttf",
  }),
  Sans: fontsOf("source-sans-pro", {
    normal: "SourceSansPro-Regular.ttf",
    bold: "SourceSansPro-Semibold.ttf",
    italics: "SourceSansPro-It.ttf",
    bolditalics: "SourceSansPro-SemiboldIt.ttf",
  }),
  SansLight: fontsOf("source-sans-pro", {
    normal: "SourceSansPro-Light.ttf",
    bold: "SourceSansPro-Regular.ttf",
    italics: "SourceSansPro-LightIt.ttf",
    bolditalics: "SourceSansPro-It.ttf",
  }),
});
// The fonts live in the virtual file system and nothing else is loaded, so a document may
// touch neither the network nor the disk. Setting both policies also silences pdfmake's
// per-call warnings.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy(() => false);

const STYLES = {
  eyebrow: { font: "Sans", bold: true, fontSize: SIZES.eyebrow, characterSpacing: 1.2, color: hex(COLORS.accent) },
  docTitle: { font: "SansLight", fontSize: SIZES.h1, color: hex(COLORS.ink), lineHeight: 1.1 },
  docSubtitle: { font: "Serif", italics: true, fontSize: 12, color: hex(COLORS.muted), lineHeight: 1.25 },
  metaLabel: { font: "Sans", bold: true, fontSize: 7.5, characterSpacing: 0.9, color: hex(COLORS.faint) },
  metaValue: { font: "Sans", fontSize: 9.5, color: hex(COLORS.body), lineHeight: 1.25 },
  running: { font: "Sans", fontSize: SIZES.running, color: hex(COLORS.faint) },
  h2: { font: "Sans", bold: true, fontSize: SIZES.h2, lineHeight: 1.15 },
  h3: { font: "Sans", bold: true, fontSize: SIZES.h3, color: hex(COLORS.ink), lineHeight: 1.2 },
  h4: { font: "Sans", bold: true, fontSize: SIZES.h4, color: hex(COLORS.muted), lineHeight: 1.2 },
  lead: { font: "Sans", bold: true, fontSize: SIZES.h4, color: hex(COLORS.ink) },
  fieldLabel: { font: "Sans", bold: true, fontSize: 8, characterSpacing: 0.6, color: hex(COLORS.accent) },
  tableHead: { font: "Sans", bold: true, fontSize: 8.5, color: hex(COLORS.white) },
  tableCell: { font: "Sans", fontSize: SIZES.table, color: hex(COLORS.body), lineHeight: 1.2 },
  tocSection: { font: "Sans", bold: true, fontSize: 10.5, color: hex(COLORS.ink) },
  tocItem: { font: "Sans", fontSize: 10.5, color: hex(COLORS.body) },
  tocPage: { font: "Sans", fontSize: 10.5, color: hex(COLORS.muted) },
};

// ---------- inline runs ----------

function runsToText(runs, base = {}) {
  return runs.map((r) => ({
    text: r.text,
    ...(r.bold ? { bold: true } : {}),
    ...(r.italic ? { italics: true } : {}),
    ...(r.strike ? { decoration: "lineThrough" } : {}),
    ...(r.link ? { link: r.link, color: hex(COLORS.accent) } : {}),
    ...base,
  }));
}

/** A run list that opens with **Label:** gets the label set as a small-caps field name. */
function labelledText(runs) {
  if (!isFieldLabel(runs[0])) return runsToText(runs);
  return [
    { text: `${runs[0].text.replace(/:\s*$/, "").toUpperCase()}  `, style: "fieldLabel" },
    ...runsToText(runs.slice(1)).map((r, i) => (i === 0 ? { ...r, text: r.text.replace(/^\s+/, "") } : r)),
  ];
}

const severityBadge = (severity) => {
  const c = SEVERITY_COLORS[severity] || SEVERITY_COLORS.Moderate;
  return {
    text: ` ${severity.toUpperCase()} `,
    font: "Sans",
    bold: true,
    fontSize: 7.5,
    characterSpacing: 0.7,
    color: hex(c.ink),
    background: hex(c.fill),
  };
};

// ---------- blocks ----------

function heading(block, ctx) {
  const text = plain(block.runs);
  const depth = block.depth + ctx.shift;

  if (depth <= 2) {
    const color = hex(sectionColor(text));
    return [
      { text, style: "h2", color, headlineLevel: 2, margin: [0, 16, 0, 3] },
      {
        canvas: [
          { type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: hex(COLORS.line) },
          { type: "line", x1: 0, y1: 0, x2: 40, y2: 0, lineWidth: 2, lineColor: color },
        ],
        margin: [0, 0, 0, 9],
      },
    ];
  }

  const issue = issueHeading(block.runs);
  if (depth === 3 && issue) {
    return [
      {
        text: [
          ...(issue.id ? [{ text: `${issue.id}  `, color: hex(COLORS.accent) }] : []),
          severityBadge(issue.severity),
          { text: `  ${issue.title}` },
        ],
        style: "h3",
        headlineLevel: 3,
        margin: [0, 12, 0, 5],
      },
    ];
  }

  return [
    {
      text: runsToText(block.runs),
      style: depth === 3 ? "h3" : "h4",
      headlineLevel: depth,
      margin: depth === 3 ? [0, 12, 0, 5] : [0, 9, 0, 3],
    },
  ];
}

const isLead = (runs) => runs.length > 0 && runs.every((r) => r.bold) && plain(runs).length <= 60;

function paragraph(block) {
  if (isLead(block.runs)) return [{ text: plain(block.runs), style: "lead", margin: [0, 7, 0, 3] }];
  return [{ text: labelledText(block.runs), margin: [0, 0, 0, 7] }];
}

/**
 * Every item of a Points to Consider entry is a **Field:** value line. Set as a two-column
 * grid, label beside value, it reads like an examination form rather than a bullet list.
 */
const isFieldList = (block) =>
  !block.ordered &&
  block.items.length >= 2 &&
  block.items.every((item) => item.length >= 1 && item[0].type === "paragraph" && isFieldLabel(item[0].runs[0]));

function fieldGrid(block, ctx) {
  const body = block.items.map((item) => {
    const [first, ...rest] = item;
    const label = first.runs[0].text.replace(/:\s*$/, "").toUpperCase();
    const value = runsToText(first.runs.slice(1)).map((r, i) => (i === 0 ? { ...r, text: r.text.replace(/^\s+/, "") } : r));
    return [
      { text: label, style: "fieldLabel", margin: [0, 2.2, 0, 0] },
      { stack: [{ text: value }, ...render(rest, ctx)] },
    ];
  });
  return [
    {
      // A row never splits, so a label is never left at the foot of a page without its value.
      table: { widths: [96, "*"], body, dontBreakRows: true },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 0,
        paddingRight: (i) => (i === 0 ? 8 : 0),
        paddingTop: () => 2,
        paddingBottom: () => 3,
      },
      margin: [0, 0, 0, 8],
    },
  ];
}

function list(block, ctx) {
  if (isFieldList(block)) return fieldGrid(block, ctx);
  const items = block.items.map((item) => {
    const [first, ...rest] = item;
    const head = first?.type === "paragraph" ? [{ text: labelledText(first.runs), margin: [0, 0, 0, 3] }] : render([first], ctx);
    return { stack: [...head, ...render(rest, ctx)] };
  });
  const key = block.ordered ? "ol" : "ul";
  return [
    {
      [key]: items,
      ...(block.ordered && block.start !== 1 ? { start: block.start } : {}),
      markerColor: hex(COLORS.accent),
      margin: [4, 0, 0, 7],
    },
  ];
}

const REF_CELL = /^(C\d+-\d+(,\s*C\d+-\d+)*|\d+(,\s*\d+)*|—|-|–)$/i;

function table(block) {
  const columns = block.header.length;
  const padX = 6;
  const available = CONTENT_WIDTH - columns * padX * 2;
  const widths = columnWeights(block).map((w) => Math.floor(w * available));

  const head = block.header.map((cell) => ({ text: runsToText(cell), style: "tableHead" }));
  const body = block.rows.map((row) =>
    Array.from({ length: columns }, (_, j) => {
      const cell = row[j] || [];
      const ref = REF_CELL.test(plain(cell).trim());
      return {
        text: runsToText(cell),
        style: "tableCell",
        ...(ref ? { color: hex(COLORS.accent), bold: true } : {}),
      };
    }),
  );

  return [
    {
      table: { headerRows: 1, widths, body: [head, ...body] },
      layout: {
        fillColor: (row) => (row === 0 ? hex(COLORS.accent) : row % 2 === 0 ? hex(COLORS.zebra) : null),
        hLineWidth: (i, node) => (i === 0 || i === 1 ? 0 : i === node.table.body.length ? 0.8 : 0.4),
        hLineColor: (i, node) => (i === node.table.body.length ? hex(COLORS.accent) : hex(COLORS.line)),
        vLineWidth: () => 0,
        paddingLeft: () => padX,
        paddingRight: () => padX,
        paddingTop: (i) => (i === 0 ? 5 : 4),
        paddingBottom: (i) => (i === 0 ? 5 : 4),
      },
      margin: [0, 4, 0, 12],
    },
  ];
}

function quote(block, ctx) {
  return [
    {
      table: { widths: ["*"], body: [[{ stack: render(block.blocks, ctx), italics: true, color: hex(COLORS.muted) }]] },
      layout: {
        hLineWidth: () => 0,
        vLineWidth: (i) => (i === 0 ? 2.5 : 0),
        vLineColor: () => hex(COLORS.accentTint),
        paddingLeft: () => 12,
        paddingTop: () => 2,
        paddingBottom: () => 0,
      },
      margin: [0, 2, 0, 8],
    },
  ];
}

function code(block) {
  return [
    {
      table: { widths: ["*"], body: [[{ text: block.text, style: "tableCell", preserveLeadingSpaces: true }]] },
      layout: {
        fillColor: () => hex(COLORS.zebra),
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 10,
        paddingRight: () => 10,
        paddingTop: () => 7,
        paddingBottom: () => 7,
      },
      margin: [0, 2, 0, 9],
    },
  ];
}

const rule = () => [
  {
    canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: hex(COLORS.line) }],
    margin: [0, 6, 0, 12],
  },
];

function render(blocks, ctx) {
  const out = [];
  for (const block of blocks) {
    if (block.type === "heading") out.push(...heading(block, ctx));
    else if (block.type === "paragraph") out.push(...paragraph(block));
    else if (block.type === "list") out.push(...list(block, ctx));
    else if (block.type === "table") out.push(...table(block));
    else if (block.type === "quote") out.push(...quote(block, ctx));
    else if (block.type === "code") out.push(...code(block));
    else if (block.type === "rule") out.push(...rule());
  }
  return out;
}

/**
 * Artifacts open with ## sections, but a model that answers with # would otherwise get a
 * heading larger than the document title. Shifting so the shallowest heading is level 2
 * keeps the hierarchy whatever depth the model started at.
 */
function headingShift(blocks) {
  const depths = blocks.filter((b) => b.type === "heading").map((b) => b.depth);
  return depths.length ? 2 - Math.min(...depths) : 0;
}

// ---------- document furniture ----------

const metaGrid = (rows) =>
  rows.length
    ? [
        {
          columns: rows.map(([label, value]) => ({
            width: label === "Examination focus" ? "*" : label === "Date" ? 104 : 84,
            stack: [
              { text: label.toUpperCase(), style: "metaLabel", margin: [0, 0, 0, 2] },
              { text: value, style: "metaValue" },
            ],
          })),
          columnGap: 28,
          margin: [0, 0, 0, 22],
        },
      ]
    : [];

function titleBlock(model, section) {
  return [
    { text: [model.heading, section.eyebrow].filter(Boolean).join("   ·   ").toUpperCase(), style: "eyebrow", margin: [0, 0, 0, 10] },
    { text: section.title, style: "docTitle", margin: [0, 0, 0, 6] },
    { text: model.documentTitle, style: "docSubtitle", margin: [0, 0, 0, 14] },
    {
      canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 1.2, lineColor: hex(COLORS.accent) }],
      margin: [0, 0, 0, 12],
    },
    ...metaGrid(model.metaRows),
  ];
}

function sectionOpening(section, index) {
  return [
    {
      text: (section.eyebrow || "").toUpperCase() || " ",
      style: "eyebrow",
      pageBreak: "before",
      margin: [0, 0, 0, 8],
    },
    { text: section.title, style: "docTitle", id: `section-${index}`, margin: [0, 0, 0, 12] },
    {
      canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 1.2, lineColor: hex(COLORS.accent) }],
      margin: [0, 0, 0, 16],
    },
  ];
}

const COVER_BAND = 340;

function cover(model) {
  const long = model.documentTitle.length > 110;
  return [
    {
      absolutePosition: { x: MARGIN_X, y: 92 },
      stack: [
        { text: model.heading.toUpperCase(), style: "eyebrow", color: hex(COLORS.accentTint), margin: [0, 0, 0, 18] },
        {
          text: model.documentTitle,
          font: "SansLight",
          fontSize: long ? 22 : SIZES.coverTitle,
          lineHeight: 1.08,
          color: hex(COLORS.white),
          margin: [0, 0, 0, 18],
        },
        { text: model.title, font: "Sans", fontSize: 13, color: hex(COLORS.accentTint) },
      ],
    },
    {
      absolutePosition: { x: MARGIN_X, y: COVER_BAND + 44 },
      stack: model.coverRows.map(([label, value]) => ({
        columns: [
          { text: label.toUpperCase(), style: "metaLabel", width: 130, margin: [0, 2, 0, 0] },
          { text: value, style: "metaValue", fontSize: 10.5, width: "*" },
        ],
        margin: [0, 0, 0, 12],
      })),
    },
    {
      absolutePosition: { x: MARGIN_X, y: 700 },
      text: DISCLAIMER,
      style: "running",
      fontSize: 8.5,
    },
    { text: "", pageBreak: "after" },
  ];
}

/** A contents page built from page references, so each entry carries its real page number. */
function contents(model) {
  const rows = [];
  let group = null;
  model.sections.forEach((section, i) => {
    if (section.group && section.group !== group) {
      group = section.group;
      rows.push([{ text: group, style: "tocSection", colSpan: 2, margin: [0, 8, 0, 0] }, {}]);
    } else if (!section.group) {
      group = null;
    }
    rows.push([
      {
        text: section.title,
        style: section.group ? "tocItem" : "tocSection",
        margin: [section.group ? 14 : 0, section.group ? 0 : 8, 0, 0],
        linkToDestination: `section-${i}`,
      },
      { text: "00", pageReference: `section-${i}`, style: "tocPage", alignment: "right", margin: [0, section.group ? 0 : 8, 0, 0] },
    ]);
  });

  return [
    { text: "CONTENTS", style: "eyebrow", margin: [0, 0, 0, 8] },
    { text: "Examination Package", style: "docTitle", margin: [0, 0, 0, 12] },
    {
      canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 1.2, lineColor: hex(COLORS.accent) }],
      margin: [0, 0, 0, 10],
    },
    {
      table: { widths: ["*", 40], body: rows },
      layout: {
        hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0 : 0.4),
        hLineColor: () => hex(COLORS.line),
        vLineWidth: () => 0,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 5,
        paddingBottom: () => 5,
      },
    },
  ];
}

// ---------- the document ----------

export async function renderPdf(model) {
  const isPackage = model.kind === "package";
  const content = [];

  if (isPackage) {
    content.push(...cover(model), ...contents(model));
    model.sections.forEach((section, i) => {
      content.push(...sectionOpening(section, i));
      content.push(...render(section.blocks, { shift: headingShift(section.blocks) }));
    });
  } else {
    const [section] = model.sections;
    content.push(...titleBlock(model, section));
    content.push(...render(section.blocks, { shift: headingShift(section.blocks) }));
  }

  const runningRight = isPackage ? model.heading : model.sections[0].runningTitle;
  const runningLeft = model.documentTitle.length > 80 ? `${model.documentTitle.slice(0, 78).trim()}…` : model.documentTitle;

  const doc = {
    pageSize: "LETTER",
    pageMargins: [MARGIN_X, 72, MARGIN_X, 64],
    info: {
      title: `${model.title} · ${model.documentTitle}`,
      author: model.heading,
      subject: model.title,
      creator: "Doctoral Examination Assistant",
    },
    defaultStyle: { font: "Serif", fontSize: SIZES.body, lineHeight: 1.32, color: hex(COLORS.body) },
    styles: STYLES,

    background: (page) => {
      if (page !== 1) return null;
      if (isPackage) {
        return {
          canvas: [
            { type: "rect", x: 0, y: 0, w: PAGE_WIDTH, h: COVER_BAND, color: hex(COLORS.accent) },
            { type: "rect", x: 0, y: COVER_BAND, w: PAGE_WIDTH, h: 5, color: hex(COLORS.accentDark) },
          ],
        };
      }
      return { canvas: [{ type: "rect", x: 0, y: 0, w: PAGE_WIDTH, h: 6, color: hex(COLORS.accent) }] };
    },

    header: (page) => {
      if (page === 1) return null;
      return {
        margin: [MARGIN_X, 34, MARGIN_X, 0],
        stack: [
          {
            columns: [
              { text: runningLeft, style: "running", width: "*" },
              { text: runningRight, style: "running", width: "auto", alignment: "right" },
            ],
            columnGap: 16,
          },
          {
            canvas: [{ type: "line", x1: 0, y1: 5, x2: CONTENT_WIDTH, y2: 5, lineWidth: 0.5, lineColor: hex(COLORS.line) }],
          },
        ],
      };
    },

    footer: (page, pages) => {
      if (isPackage && page === 1) return null;
      return {
        margin: [MARGIN_X, 22, MARGIN_X, 0],
        columns: [
          { text: DISCLAIMER, style: "running", width: "*" },
          { text: `${page} / ${pages}`, style: "running", width: "auto", alignment: "right" },
        ],
        columnGap: 16,
      };
    },

    // Never leave a heading stranded as the last line of a page.
    pageBreakBefore: (node, ctx) =>
      Boolean(node.headlineLevel) &&
      ctx.getFollowingNodesOnPage().every((n) => n.headlineLevel) &&
      ctx.getNodesOnNextPage().length > 0,

    content,
  };

  return Buffer.from(await pdfmake.createPdf(doc).getBuffer());
}
