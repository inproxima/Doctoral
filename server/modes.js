/**
 * Examination modes.
 *
 * A mode is the whole shape of one examination: which chapters exist, what each
 * chapter is answerable for, and the handful of nouns and verdicts the prompts need
 * so they read correctly for the document in front of them.
 *
 * Dissertation is the original six-chapter examination. Proposal is the same
 * examination applied to a document that stops at Chapter 3 and has produced no
 * results yet, so its chapter scopes never defer to a chapter that does not exist.
 *
 * Everything chapter-shaped in the app reads its chapter list from here. Nothing
 * else may hard-code a chapter count.
 */

export const DEFAULT_MODE = "dissertation";

// Chapters 1 to 3 are the same three chapters in both modes, so their names and icons
// are shared and only the descriptor sentence changes with the document.
const SHARED_ICONS = { 1: "📖", 2: "📚", 3: "🔬" };
const SHARED_NAMES = { 1: "Introduction", 2: "Literature Review", 3: "Methodology" };

const describe = (document, ordinals) =>
  Object.fromEntries(
    Object.entries(ordinals).map(([n, ordinal]) => [
      n,
      {
        name: SHARED_NAMES[n],
        icon: SHARED_ICONS[n],
        descriptor: `${ordinal} chapter of the ${document} (${SHARED_NAMES[n]})`,
      },
    ]),
  );

export const MODES = {
  dissertation: {
    id: "dissertation",
    label: "Dissertation",
    optionLabel: "Dissertation (6 chapters)",
    heading: "Doctoral Dissertation Examination",
    chapters: [1, 2, 3, 4, 5, 6],

    // Prose the prompts splice in. noun goes after an article, shortNoun stands alone.
    noun: "doctoral dissertation",
    shortNoun: "dissertation",
    defence: "doctoral oral defence",
    // What the oral tab is called and how the supervisor brief frames the moment.
    oralTabLabel: "Oral Defence",
    oralHeading: "Oral Defence Questions",
    supervisorContext:
      "The candidate has submitted the completed dissertation for final examination. " +
      "The supervisor will decide what to relay before the oral defence and the revision round.",
    committee: "doctoral examination committee",
    claim: "the defensibility of the doctoral claim",
    criticalConsequence: "the degree cannot be awarded until it is resolved",
    verdicts:
      "acceptable as-is / minor revisions / major revisions / not acceptable for doctoral conferral",
    // The letter and the second-round report state the decision more tersely than the
    // final review does. Both wordings are per mode so neither drifts from the other.
    decisions: "accept / minor revisions / major revisions / not acceptable",
    exampleChapters: "2, 5",

    descriptions: {
      ...describe("dissertation", { 1: "first", 2: "second", 3: "third" }),
      4: {
        name: "Results/Findings",
        icon: "📊",
        descriptor: "fourth chapter of the dissertation (Results/Findings)",
      },
      5: {
        name: "Discussion/Analysis",
        icon: "💬",
        descriptor: "fifth chapter of the dissertation (Discussion/Analysis)",
      },
      6: {
        name: "Conclusion",
        icon: "🎯",
        descriptor: "sixth chapter of the dissertation (Conclusion)",
      },
    },

    // Each chapter is judged only against its own remit. Stating the exclusions explicitly is what
    // stops the same criterion — and therefore the same criticism — being generated six times.
    scope: {
      1: {
        owns:
          "Framing of the research problem; statement and justification of the knowledge gap; " +
          "research questions/objectives and their alignment with the problem; significance and " +
          "rationale; scope, delimitations, and definitions of key terms; the roadmap of the argument.",
        notHere:
          "Exhaustive synthesis or critique of the literature (Chapter 2); detailed methodological " +
          "design, instruments, or sampling (Chapter 3); any findings (Chapter 4).",
      },
      2: {
        owns:
          "Coverage, currency, and selection logic of the literature; critical synthesis rather than " +
          "summary; construction and justification of the theoretical/conceptual framework; how the " +
          "reviewed work substantiates the gap claimed in Chapter 1; treatment of contradictory evidence.",
        notHere:
          "Re-stating the problem or research questions (Chapter 1); operational detail of instruments, " +
          "sampling, or analysis procedure (Chapter 3); interpretation of this study's results (Chapter 5).",
      },
      3: {
        owns:
          "Research design and its fit to the research questions; philosophical/paradigmatic positioning; " +
          "population, sampling strategy, and sample size justification; instrumentation and its " +
          "validation; data-collection procedure; analysis plan and its appropriateness; validity, " +
          "reliability/trustworthiness, and threats to them; ethics, consent, and data governance; " +
          "replicability of the described procedure.",
        notHere:
          "Justifying the gap or the research questions themselves (Chapters 1–2); reporting or " +
          "interpreting results (Chapters 4–5).",
      },
      4: {
        owns:
          "Completeness and accuracy of results reporting; alignment of reported results to each research " +
          "question; correct and sufficient statistical/analytical reporting (effect sizes, assumptions, " +
          "uncertainty, qualitative evidence and its provenance); quality, labelling, and self-sufficiency " +
          "of tables and figures; restraint from interpretation; transparency about missing or negative results.",
        notHere:
          "Re-explaining or re-justifying the method (Chapter 3); interpreting findings against the " +
          "literature or drawing implications (Chapter 5).",
      },
      5: {
        owns:
          "Interpretation of findings against the framework and literature from Chapter 2; whether claims " +
          "are proportionate to the evidence reported in Chapter 4; engagement with alternative or " +
          "disconfirming explanations; articulation of the theoretical and practical contribution; " +
          "honest, specific limitations and their consequences for the claims.",
        notHere:
          "Re-reporting the results themselves (Chapter 4); re-describing the method (Chapter 3); " +
          "final conclusions and future-research agenda (Chapter 6).",
      },
      6: {
        owns:
          "Whether the conclusions are warranted by, and traceable to, the reported findings; the explicit " +
          "statement of the contribution to knowledge and its defensibility as doctoral-level; the " +
          "closing of the loop back to the Chapter 1 problem and research questions; recommendations for " +
          "practice/policy and their grounding; the future-research agenda; overall closure of the argument.",
        notHere:
          "Introducing new data, analysis, or literature; repeating the interpretive argument of " +
          "Chapter 5; restating limitations already given in Chapter 5 beyond a one-line reference.",
      },
    },

    summaryOutline: [
      "Research Problem & Objectives",
      "Research Gap & Significance",
      "Theoretical Framework",
      "Methodology Overview",
      "Key Findings",
      "Theoretical Contributions",
      "Practical Implications",
      "Limitations",
      "Future Research",
      "Overall Assessment of coherence, rigor, and contribution to knowledge",
    ],

    overallOralFoci: [
      "Coherence and progression of argument across chapters",
      "Significance and originality of the contribution to knowledge",
      "The candidate's grasp of broader implications and positioning",
      "Ethical considerations and study limitations",
      "Future research directions and the candidate's readiness for independent scholarship",
    ],
  },

  proposal: {
    id: "proposal",
    label: "Proposal",
    optionLabel: "Proposal (3 chapters)",
    heading: "Doctoral Proposal Examination",
    chapters: [1, 2, 3],

    noun: "doctoral research proposal",
    shortNoun: "proposal",
    defence: "doctoral proposal defence",
    oralTabLabel: "Candidacy Oral Exam",
    oralHeading: "Candidacy Oral Exam Questions",
    supervisorContext:
      "The student is preparing to defend this proposal and seek approval to proceed to data " +
      "collection. The supervisor will decide what to relay before the candidacy oral exam.",
    committee: "doctoral proposal committee",
    claim: "the viability of the proposed study",
    criticalConsequence: "the proposal cannot be approved until it is resolved",
    verdicts:
      "approved as-is / approved with minor revisions / major revisions required / not approved to proceed",
    decisions: "approve / approve with minor revisions / major revisions required / not approved",
    exampleChapters: "2, 3",

    descriptions: describe("research proposal", { 1: "first", 2: "second", 3: "third" }),

    // Chapter 3 is the last chapter here, so it owns the whole method including the analysis
    // plan, and nothing may be deferred to a chapter the proposal does not have.
    scope: {
      1: {
        owns:
          "Framing of the research problem; statement and justification of the knowledge gap; " +
          "research questions/objectives and their alignment with the problem; significance and " +
          "rationale; scope, delimitations, and definitions of key terms; the roadmap of the argument.",
        notHere:
          "Exhaustive synthesis or critique of the literature (Chapter 2); detailed methodological " +
          "design, instruments, or sampling (Chapter 3).",
      },
      2: {
        owns:
          "Coverage, currency, and selection logic of the literature; critical synthesis rather than " +
          "summary; construction and justification of the theoretical/conceptual framework; how the " +
          "reviewed work substantiates the gap claimed in Chapter 1; treatment of contradictory evidence.",
        notHere:
          "Re-stating the problem or research questions (Chapter 1); operational detail of instruments, " +
          "sampling, or analysis procedure (Chapter 3).",
      },
      3: {
        owns:
          "Proposed research design and its fit to the research questions; philosophical/paradigmatic " +
          "positioning; population, sampling strategy, and sample size justification; instrumentation " +
          "and how it will be validated; data-collection procedure; analysis plan and its " +
          "appropriateness to the questions and the data; validity, reliability/trustworthiness, and " +
          "threats to them; ethics, consent, and data governance; feasibility, timeline, and the " +
          "resources the study assumes; replicability of the described procedure.",
        notHere:
          "Re-justifying the gap or the research questions themselves (Chapters 1–2); presenting or " +
          "interpreting results, which the proposed study has not yet produced.",
      },
    },

    summaryOutline: [
      "Research Problem & Objectives",
      "Research Gap & Significance",
      "Theoretical Framework",
      "Proposed Methodology",
      "Anticipated Contributions",
      "Feasibility, Timeline & Ethics",
      "Limitations & Risks",
      "Overall Assessment of coherence, rigor, and readiness to proceed",
    ],

    overallOralFoci: [
      "Coherence and progression of argument across chapters",
      "Significance and originality of the intended contribution to knowledge",
      "The candidate's command of the proposed method and the alternatives rejected",
      "Ethical considerations and anticipated risks to participants and data",
      "Feasibility, timeline, and the candidate's contingency plans if the design fails",
    ],
  },
};

/** Resolve a stored or requested mode id, falling back for runs written before modes existed. */
export const getMode = (id) => MODES[id] || MODES[DEFAULT_MODE];

export const isMode = (id) => Object.hasOwn(MODES, id || "");

/** The shape the browser needs to draw tabs and the chapter table, one entry per mode. */
export const modeCatalogue = () =>
  Object.fromEntries(
    Object.values(MODES).map((m) => [
      m.id,
      {
        id: m.id,
        label: m.label,
        optionLabel: m.optionLabel,
        heading: m.heading,
        oralTabLabel: m.oralTabLabel,
        oralHeading: m.oralHeading,
        chapters: m.chapters,
        descriptions: m.descriptions,
      },
    ]),
  );
