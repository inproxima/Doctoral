/**
 * One palette and type scale for both exporters, so the Word file and the PDF of the same
 * artifact read as the same document. The accent is the app's own (public/style.css).
 *
 * Colours are bare hex because that is what docx wants. The PDF renderer prefixes '#'.
 */

export const COLORS = {
  ink: "1C2430",
  body: "2A3340",
  muted: "67707E",
  faint: "98A0AC",
  line: "DDE2E8",
  accent: "2F5D8A",
  accentDark: "1F3F60",
  accentTint: "E9EFF6",
  zebra: "F6F8FA",
  good: "2E7D54",
  warn: "A8632A",
  bad: "A83A3A",
  white: "FFFFFF",
};

export const SEVERITY_COLORS = {
  Critical: { ink: "A83A3A", fill: "FBE4E4" },
  Major: { ink: "A8632A", fill: "FBEEE0" },
  Moderate: { ink: "2F5D8A", fill: "E9EFF6" },
  Minor: { ink: "2E7D54", fill: "E8F2EC" },
};

/** Type sizes in points. */
export const SIZES = {
  body: 10.5,
  small: 9,
  table: 9,
  eyebrow: 8,
  running: 8,
  h1: 22,
  h2: 14,
  h3: 11.5,
  h4: 10.5,
  coverTitle: 28,
};

/**
 * The examiner's section headings replace the app's emoji markers with colour: the
 * strengths read green and the issues amber, as ✅ and ⚠️ did on screen.
 */
export function sectionColor(heading) {
  const h = String(heading || "").toLowerCase();
  if (/strength|resolved items$/.test(h) && !/partially|unresolved/.test(h)) return COLORS.good;
  if (/points to consider|concern|unresolved|communicate to the student/.test(h)) return COLORS.warn;
  return COLORS.accent;
}

export const DISCLAIMER =
  "AI-assisted examination. Final decisions must always involve human expert judgement.";
