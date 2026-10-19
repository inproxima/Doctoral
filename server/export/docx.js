/**
 * Word rendering through the docx library.
 *
 * Word does not embed fonts the way a PDF does, so the faces are Cambria and Calibri, which
 * Office installs on both Windows and macOS and Google Docs substitutes faithfully. The
 * layout, palette and hierarchy are the PDF's, from the same theme.
 *
 * Measurements are in twips (1/20 pt) and font sizes in half points, as Word stores them.
 */
import {
  AlignmentType,
  BorderStyle,
  Bookmark,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  HeightRule,
  InternalHyperlink,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlignTable,
  WidthType,
} from "docx";

import { COLORS, DISCLAIMER, SEVERITY_COLORS, SIZES, sectionColor } from "./theme.js";
import { columnWeights, isFieldLabel, issueHeading, plain } from "./markdown.js";

const SERIF = "Cambria";
const SANS = "Calibri";
const SANS_LIGHT = "Calibri Light";

const pt = (n) => Math.round(n * 2); // half points
const tw = (n) => Math.round(n * 20); // twips

const PAGE = { width: 12240, height: 15840, margin: 1440 };
const CONTENT = PAGE.width - PAGE.margin * 2; // 9360
const LIST_INDENT = 360;

const NONE = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
const line = (color, size = 4, space = 4) => ({ style: BorderStyle.SINGLE, size, color, space });

// ---------- inline runs ----------

/** A line break inside a run becomes a Word break rather than a literal newline. */
function textRuns(text, props) {
  return String(text)
    .split("\n")
    .map((part, i) => new TextRun({ ...props, text: part, ...(i > 0 ? { break: 1 } : {}) }));
}

function runs(list, base = {}) {
  return list.flatMap((r) => {
    const props = {
      ...base,
      ...(r.bold ? { bold: true } : {}),
      ...(r.italic ? { italics: true } : {}),
      ...(r.strike ? { strike: true } : {}),
    };
    if (r.link && /^(https?:|mailto:)/i.test(r.link)) {
      return [new ExternalHyperlink({ link: r.link, children: textRuns(r.text, { ...props, style: "Hyperlink" }) })];
    }
    return textRuns(r.text, props);
  });
}

const labelRun = (text) =>
  new TextRun({
    text: `${text.replace(/:\s*$/, "").toUpperCase()}  `,
    font: SANS,
    bold: true,
    size: pt(8),
    color: COLORS.accent,
    characterSpacing: 12,
  });

/** **Where:** at the head of a line becomes a small-caps field name, as in the PDF. */
function labelledRuns(list) {
  if (!isFieldLabel(list[0])) return runs(list);
  const rest = list.slice(1).map((r, i) => (i === 0 ? { ...r, text: r.text.replace(/^\s+/, "") } : r));
  return [labelRun(list[0].text), ...runs(rest)];
}

const severityRun = (severity) => {
  const c = SEVERITY_COLORS[severity] || SEVERITY_COLORS.Moderate;
  return new TextRun({
    text: ` ${severity.toUpperCase()} `,
    font: SANS,
    bold: true,
    size: pt(7.5),
    color: c.ink,
    characterSpacing: 14,
    shading: { type: ShadingType.CLEAR, color: "auto", fill: c.fill },
  });
};

// ---------- blocks ----------

/**
 * Lists need numbering definitions that exist before the document is built, and every
 * ordered list needs its own instance or Word continues the count across lists. The
 * context collects both while rendering.
 */
function createContext() {
  return { shift: 0, instance: 0, starts: new Set() };
}

function heading(block, ctx) {
  const text = plain(block.runs);
  const depth = block.depth + ctx.shift;

  if (depth <= 2) {
    const color = sectionColor(text);
    return [
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        border: { bottom: line(COLORS.line, 4, 3) },
        children: [new TextRun({ text, color })],
      }),
    ];
  }

  const issue = issueHeading(block.runs);
  if (depth === 3 && issue) {
    return [
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [
          ...(issue.id ? [new TextRun({ text: `${issue.id}  `, color: COLORS.accent })] : []),
          severityRun(issue.severity),
          new TextRun({ text: `  ${issue.title}` }),
        ],
      }),
    ];
  }

  return [
    new Paragraph({
      heading: depth === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4,
      children: runs(block.runs),
    }),
  ];
}

const isLead = (list) => list.length > 0 && list.every((r) => r.bold) && plain(list).length <= 60;

function paragraph(block, indent = 0) {
  if (isLead(block.runs)) {
    return [
      new Paragraph({
        keepNext: true,
        spacing: { before: 140, after: 60 },
        indent: indent ? { left: indent } : undefined,
        children: [new TextRun({ text: plain(block.runs), font: SANS, bold: true, size: pt(SIZES.h4), color: COLORS.ink })],
      }),
    ];
  }
  return [new Paragraph({ indent: indent ? { left: indent } : undefined, children: labelledRuns(block.runs) })];
}

const isFieldList = (block) =>
  !block.ordered &&
  block.items.length >= 2 &&
  block.items.every((item) => item.length >= 1 && item[0].type === "paragraph" && isFieldLabel(item[0].runs[0]));

/** **Where:** / **Evidence:** bullets set as a borderless label and value grid. */
function fieldGrid(block, ctx) {
  const labelWidth = 1700;
  const rows = block.items.map((item) => {
    const [first, ...rest] = item;
    const value = first.runs.slice(1).map((r, i) => (i === 0 ? { ...r, text: r.text.replace(/^\s+/, "") } : r));
    return new TableRow({
      children: [
        new TableCell({
          width: { size: labelWidth, type: WidthType.DXA },
          margins: { top: 50, bottom: 50, left: 0, right: 160 },
          children: [
            new Paragraph({
              spacing: { after: 0, before: 30 },
              children: [
                new TextRun({
                  text: first.runs[0].text.replace(/:\s*$/, "").toUpperCase(),
                  font: SANS,
                  bold: true,
                  size: pt(8),
                  color: COLORS.accent,
                  characterSpacing: 12,
                }),
              ],
            }),
          ],
        }),
        new TableCell({
          width: { size: CONTENT - labelWidth, type: WidthType.DXA },
          margins: { top: 50, bottom: 50, left: 0, right: 0 },
          children: [new Paragraph({ spacing: { after: 60 }, children: runs(value) }), ...render(rest, ctx)],
        }),
      ],
    });
  });

  return [
    new Table({
      width: { size: CONTENT, type: WidthType.DXA },
      columnWidths: [labelWidth, CONTENT - labelWidth],
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows,
    }),
    spacer(80),
  ];
}

function list(block, ctx, level = 0) {
  if (level === 0 && isFieldList(block)) return fieldGrid(block, ctx);

  let reference = "bullets";
  let instance = 0;
  if (block.ordered) {
    reference = block.start === 1 ? "ordered" : `ordered-${block.start}`;
    if (block.start !== 1) ctx.starts.add(block.start);
    ctx.instance += 1;
    instance = ctx.instance;
  }
  const textIndent = LIST_INDENT * (level + 1);

  const out = [];
  for (const item of block.items) {
    item.forEach((child, i) => {
      if (child.type === "list") {
        out.push(...list(child, ctx, Math.min(level + 1, 3)));
      } else if (child.type === "paragraph" && i === 0) {
        out.push(
          new Paragraph({
            numbering: { reference, level, instance },
            spacing: { after: 80 },
            children: labelledRuns(child.runs),
          }),
        );
      } else if (child.type === "paragraph") {
        // A second paragraph inside an item ("Follow up." under a question) hangs at the text indent.
        out.push(...paragraph(child, textIndent));
      } else {
        out.push(...render([child], ctx));
      }
    });
  }
  return level === 0 ? [...out, spacer(60)] : out;
}

const REF_CELL = /^(C\d+-\d+(,\s*C\d+-\d+)*|\d+(,\s*\d+)*|—|-|–)$/i;

function table(block) {
  const columns = block.header.length;
  const widths = columnWeights(block).map((w) => Math.floor(w * CONTENT));
  const margins = { top: 70, bottom: 70, left: 110, right: 110 };

  const cellParagraph = (cell, props) =>
    new Paragraph({ spacing: { after: 0, line: 252 }, children: runs(cell, { font: SANS, size: pt(SIZES.table), ...props }) });

  const head = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: block.header.map(
      (cell, j) =>
        new TableCell({
          width: { size: widths[j], type: WidthType.DXA },
          margins,
          verticalAlign: VerticalAlignTable.CENTER,
          shading: { type: ShadingType.CLEAR, color: "auto", fill: COLORS.accent },
          children: [cellParagraph(cell, { bold: true, color: COLORS.white, size: pt(8.5) })],
        }),
    ),
  });

  const body = block.rows.map(
    (row, i) =>
      new TableRow({
        cantSplit: true,
        children: Array.from({ length: columns }, (_, j) => {
          const cell = row[j] || [];
          const ref = REF_CELL.test(plain(cell).trim());
          return new TableCell({
            width: { size: widths[j], type: WidthType.DXA },
            margins,
            ...(i % 2 === 1 ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: COLORS.zebra } } : {}),
            children: [cellParagraph(cell, ref ? { bold: true, color: COLORS.accent } : { color: COLORS.body })],
          });
        }),
      }),
  );

  return [
    new Table({
      width: { size: CONTENT, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      borders: {
        top: NONE,
        left: NONE,
        right: NONE,
        insideVertical: NONE,
        bottom: line(COLORS.accent, 8, 0),
        insideHorizontal: line(COLORS.line, 4, 0),
      },
      rows: [head, ...body],
    }),
    spacer(160),
  ];
}

function code(block) {
  return [
    new Paragraph({
      shading: { type: ShadingType.CLEAR, color: "auto", fill: COLORS.zebra },
      border: { top: line(COLORS.zebra, 4, 6), bottom: line(COLORS.zebra, 4, 6), left: line(COLORS.zebra, 4, 8), right: line(COLORS.zebra, 4, 8) },
      children: textRuns(block.text, { font: SANS, size: pt(SIZES.table) }),
    }),
  ];
}

const spacer = (after) => new Paragraph({ spacing: { before: 0, after, line: 120 }, children: [] });

const rule = () => [new Paragraph({ border: { bottom: line(COLORS.line, 4, 1) }, spacing: { after: 200 }, children: [] })];

function render(blocks, ctx) {
  const out = [];
  for (const block of blocks) {
    if (block.type === "heading") out.push(...heading(block, ctx));
    else if (block.type === "paragraph") out.push(...paragraph(block));
    else if (block.type === "list") out.push(...list(block, ctx));
    else if (block.type === "table") out.push(...table(block));
    else if (block.type === "quote") out.push(...quoteBlock(block, ctx));
    else if (block.type === "code") out.push(...code(block));
    else if (block.type === "rule") out.push(...rule());
  }
  return out;
}

/** Quoted passages keep their own paragraphs, indented behind a tinted bar. */
function quoteBlock(block, ctx) {
  return block.blocks.flatMap((b) =>
    b.type === "paragraph"
      ? [
          new Paragraph({
            indent: { left: 240 },
            border: { left: line(COLORS.accentTint, 18, 10) },
            children: runs(b.runs, { italics: true, color: COLORS.muted }),
          }),
        ]
      : render([b], ctx),
  );
}

function headingShift(blocks) {
  const depths = blocks.filter((b) => b.type === "heading").map((b) => b.depth);
  return depths.length ? 2 - Math.min(...depths) : 0;
}

// ---------- document furniture ----------

const eyebrow = (text, color = COLORS.accent) =>
  new Paragraph({
    spacing: { after: 160 },
    children: [new TextRun({ text: text.toUpperCase(), font: SANS, bold: true, size: pt(SIZES.eyebrow), color, characterSpacing: 24 })],
  });

const accentRule = (after = 240) =>
  new Paragraph({ border: { bottom: line(COLORS.accent, 12, 1) }, spacing: { after }, children: [] });

function metaTable(rows) {
  if (!rows.length) return [];
  const focusIndex = rows.findIndex(([label]) => label === "Examination focus");
  const fixed = 2100;
  const widths = rows.map((_, i) => (i === focusIndex ? 0 : fixed));
  const flexible = CONTENT - widths.reduce((a, b) => a + b, 0);
  const columnWidths = widths.map((w) => w || flexible);
  if (focusIndex < 0) columnWidths[columnWidths.length - 1] += flexible;

  return [
    new Table({
      width: { size: CONTENT, type: WidthType.DXA },
      columnWidths,
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: [
        new TableRow({
          children: rows.map(
            ([label, value], i) =>
              new TableCell({
                width: { size: columnWidths[i], type: WidthType.DXA },
                margins: { top: 0, bottom: 0, left: 0, right: 240 },
                children: [
                  new Paragraph({
                    spacing: { after: 40 },
                    children: [new TextRun({ text: label.toUpperCase(), font: SANS, bold: true, size: pt(7.5), color: COLORS.faint, characterSpacing: 18 })],
                  }),
                  new Paragraph({
                    spacing: { after: 0, line: 264 },
                    children: [new TextRun({ text: value, font: SANS, size: pt(9.5), color: COLORS.body })],
                  }),
                ],
              }),
          ),
        }),
      ],
    }),
    spacer(360),
  ];
}

function titleBlock(model, section) {
  return [
    eyebrow([model.heading, section.eyebrow].filter(Boolean).join("   ·   ")),
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(section.title)] }),
    new Paragraph({
      spacing: { after: 220 },
      children: [new TextRun({ text: model.documentTitle, font: SERIF, italics: true, size: pt(12), color: COLORS.muted })],
    }),
    accentRule(220),
    ...metaTable(model.metaRows),
  ];
}

const bookmarkId = (i) => `section_${i + 1}`;

function sectionOpening(section, index) {
  return [
    eyebrow(section.eyebrow || " "),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new Bookmark({ id: bookmarkId(index), children: [new TextRun(section.title)] })],
    }),
    accentRule(320),
  ];
}

/**
 * A full-bleed cover band. The table is widened to the page and pulled left into the margin,
 * and the cover section has no top margin, so the band meets the edges of the sheet.
 */
function cover(model) {
  const long = model.documentTitle.length > 110;
  const band = new Table({
    width: { size: PAGE.width, type: WidthType.DXA },
    columnWidths: [PAGE.width],
    indent: { size: -PAGE.margin, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        height: { value: tw(330), rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            width: { size: PAGE.width, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, color: "auto", fill: COLORS.accent },
            verticalAlign: VerticalAlignTable.BOTTOM,
            margins: { top: 1200, bottom: 760, left: PAGE.margin, right: PAGE.margin },
            children: [
              eyebrow(model.heading, COLORS.accentTint),
              new Paragraph({
                spacing: { after: 280, line: 264 },
                children: [new TextRun({ text: model.documentTitle, font: SANS_LIGHT, size: pt(long ? 22 : SIZES.coverTitle), color: COLORS.white })],
              }),
              new Paragraph({
                spacing: { after: 0 },
                children: [new TextRun({ text: model.title, font: SANS, size: pt(13), color: COLORS.accentTint })],
              }),
            ],
          }),
        ],
      }),
    ],
  });

  const rows = model.coverRows.map(
    ([label, value]) =>
      new TableRow({
        children: [
          new TableCell({
            width: { size: 2600, type: WidthType.DXA },
            margins: { top: 60, bottom: 160, left: 0, right: 200 },
            children: [
              new Paragraph({
                spacing: { after: 0, before: 20 },
                children: [new TextRun({ text: label.toUpperCase(), font: SANS, bold: true, size: pt(7.5), color: COLORS.faint, characterSpacing: 18 })],
              }),
            ],
          }),
          new TableCell({
            width: { size: CONTENT - 2600, type: WidthType.DXA },
            margins: { top: 60, bottom: 160, left: 0, right: 0 },
            children: [new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: value, font: SANS, size: pt(10.5), color: COLORS.body })] })],
          }),
        ],
      }),
  );

  return [
    band,
    new Paragraph({ spacing: { after: 720 }, children: [] }),
    new Table({
      width: { size: CONTENT, type: WidthType.DXA },
      columnWidths: [2600, CONTENT - 2600],
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows,
    }),
    new Paragraph({
      spacing: { before: 1600 },
      children: [new TextRun({ text: DISCLAIMER, font: SANS, size: pt(8.5), color: COLORS.faint })],
    }),
  ];
}

/**
 * Word's own TOC field would need updating on open, which Word announces with a prompt
 * about fields referring to other files. A static contents list with working links reads
 * the same and opens silently.
 */
function contents(model) {
  const out = [eyebrow("Contents"), new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("Examination Package")] }), accentRule(200)];
  let group = null;
  model.sections.forEach((section, i) => {
    if (section.group && section.group !== group) {
      group = section.group;
      out.push(
        new Paragraph({
          spacing: { before: 200, after: 60 },
          children: [new TextRun({ text: group, font: SANS, bold: true, size: pt(10.5), color: COLORS.ink })],
        }),
      );
    } else if (!section.group) {
      group = null;
    }
    out.push(
      new Paragraph({
        spacing: { before: section.group ? 0 : 200, after: 60 },
        indent: section.group ? { left: 280 } : undefined,
        border: { bottom: line(COLORS.line, 4, 4) },
        children: [
          new InternalHyperlink({
            anchor: bookmarkId(i),
            children: [
              new TextRun({
                text: section.title,
                font: SANS,
                size: pt(10.5),
                bold: !section.group,
                color: section.group ? COLORS.body : COLORS.ink,
              }),
            ],
          }),
        ],
      }),
    );
  });
  return out;
}

function runningHeader(left, right) {
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT }],
        border: { bottom: line(COLORS.line, 4, 4) },
        children: [
          new TextRun({ text: left, font: SANS, size: pt(SIZES.running), color: COLORS.faint }),
          new TextRun({ text: `\t${right}`, font: SANS, size: pt(SIZES.running), color: COLORS.faint }),
        ],
      }),
    ],
  });
}

/** The first page of a single artifact carries an accent bar where the running header would be. */
const accentHeader = () =>
  new Header({ children: [new Paragraph({ border: { top: line(COLORS.accent, 24, 0) }, children: [] })] });

const emptyHeader = () => new Header({ children: [new Paragraph({ children: [] })] });

function footer() {
  return new Footer({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: CONTENT }],
        children: [
          new TextRun({ text: DISCLAIMER, font: SANS, size: pt(SIZES.running), color: COLORS.faint }),
          new TextRun({
            children: ["\tPage ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES],
            font: SANS,
            size: pt(SIZES.running),
            color: COLORS.faint,
          }),
        ],
      }),
    ],
  });
}

// ---------- numbering and styles ----------

const BULLETS = ["•", "◦", "▪", "•"];
const ORDERED_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN, LevelFormat.DECIMAL];

const levelIndent = (level) => ({ left: LIST_INDENT * (level + 1), hanging: 280 });

function orderedConfig(reference, start = 1) {
  return {
    reference,
    levels: ORDERED_FORMATS.map((format, level) => ({
      level,
      format,
      text: `%${level + 1}.`,
      start: level === 0 ? start : 1,
      alignment: AlignmentType.LEFT,
      style: {
        paragraph: { indent: levelIndent(level) },
        run: { font: SANS, bold: true, color: COLORS.accent, size: pt(SIZES.body - 0.5) },
      },
    })),
  };
}

function numbering(ctx) {
  return {
    config: [
      {
        reference: "bullets",
        levels: BULLETS.map((text, level) => ({
          level,
          format: LevelFormat.BULLET,
          text,
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: levelIndent(level) }, run: { font: SANS, color: COLORS.accent } },
        })),
      },
      orderedConfig("ordered"),
      ...[...ctx.starts].map((start) => orderedConfig(`ordered-${start}`, start)),
    ],
  };
}

const STYLES = {
  default: {
    document: {
      run: { font: SERIF, size: pt(SIZES.body), color: COLORS.body },
      paragraph: { spacing: { after: 140, line: 300 } },
    },
    title: {
      run: { font: SANS_LIGHT, size: pt(SIZES.h1 + 2), color: COLORS.ink },
      paragraph: { spacing: { before: 0, after: 100 } },
    },
    heading1: {
      run: { font: SANS_LIGHT, size: pt(SIZES.h1), color: COLORS.ink },
      paragraph: { spacing: { before: 0, after: 200 }, keepNext: true },
    },
    heading2: {
      run: { font: SANS, size: pt(SIZES.h2), bold: true, color: COLORS.accent },
      paragraph: { spacing: { before: 360, after: 160 }, keepNext: true, keepLines: true },
    },
    heading3: {
      run: { font: SANS, size: pt(SIZES.h3), bold: true, color: COLORS.ink },
      paragraph: { spacing: { before: 260, after: 100 }, keepNext: true, keepLines: true },
    },
    heading4: {
      run: { font: SANS, size: pt(SIZES.h4), bold: true, color: COLORS.muted },
      paragraph: { spacing: { before: 200, after: 60 }, keepNext: true },
    },
    hyperlink: { run: { color: COLORS.accent, underline: {} } },
  },
};

// ---------- the document ----------

const sectionPage = (marginTop = PAGE.margin) => ({
  size: { width: PAGE.width, height: PAGE.height },
  margin: { top: marginTop, right: PAGE.margin, bottom: 1300, left: PAGE.margin, header: 620, footer: 560 },
});

export async function renderDocx(model) {
  const ctx = createContext();
  const runningLeft = model.documentTitle.length > 80 ? `${model.documentTitle.slice(0, 78).trim()}…` : model.documentTitle;
  const sections = [];

  if (model.kind === "package") {
    sections.push({
      properties: { page: sectionPage(0) },
      headers: { default: emptyHeader() },
      footers: { default: new Footer({ children: [new Paragraph({ children: [] })] }) },
      children: cover(model),
    });
    sections.push({
      properties: { page: sectionPage() },
      headers: { default: runningHeader(runningLeft, model.heading) },
      footers: { default: footer() },
      children: contents(model),
    });
    model.sections.forEach((section, i) => {
      ctx.shift = headingShift(section.blocks);
      sections.push({
        properties: { page: sectionPage(), titlePage: true },
        headers: { default: runningHeader(runningLeft, section.runningTitle), first: emptyHeader() },
        footers: { default: footer(), first: footer() },
        children: [...sectionOpening(section, i), ...render(section.blocks, ctx)],
      });
    });
  } else {
    const [section] = model.sections;
    ctx.shift = headingShift(section.blocks);
    sections.push({
      properties: { page: sectionPage(), titlePage: true },
      headers: { default: runningHeader(runningLeft, section.runningTitle), first: accentHeader() },
      footers: { default: footer(), first: footer() },
      children: [...titleBlock(model, section), ...render(section.blocks, ctx)],
    });
  }

  const doc = new Document({
    creator: model.heading,
    title: `${model.title} · ${model.documentTitle}`,
    description: model.title,
    styles: STYLES,
    numbering: numbering(ctx),
    sections,
  });
  return Packer.toBuffer(doc);
}
