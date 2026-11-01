/**
 * Pi-vcc compile entry — orchestrates normalization → noise filtering →
 * ranked brief selection → section building → merge-with-previous.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/summarize.ts)
 * merged at the 0.11.0 section redesign:
 * - Sections are [Early Session Requests] / [Files And Changes] / [Commits] /
 *   [Tracked Commands] / [User Messages] — verbatim user text picked by
 *   position, no English keyword interpretation. pi-blackhole's [User
 *   Decisions] is kept. The removed [Session Goal] / [User Preferences] /
 *   [Outstanding Context] are migrated: a previous summary's first real
 *   [Session Goal] line becomes the early requests; the rest is dropped.
 * - Header extraction is shape-based (a "[Title Case]" line standing alone in
 *   the head area), not a name-list regex scan, so transcript text that
 *   mentions a header name can no longer merge in as junk (upstream #60).
 * - The brief transcript uses upstream's signal-density ranking under a
 *   size-relative character budget (core/rank.ts) instead of a fixed cap.
 *
 * Modified by pi-blackhole:
 * - threads touchMessages/cwd/gitTags into buildSections for file-touch
 *   attribution (src/extract/file-touch.ts) and richer Files And Changes.
 * - OM coupling: stripOMContent / extractRecallNote around the merge; recall
 *   notes stripped with paragraph matching before merging.
 * - mergeFileLines: multi-line Files And Changes parse with git-tag handling
 *   — the canonical Files merger; it parses both the blackhole multi-line
 *   render and the upstream single-line shape, so summaries written by any
 *   version merge correctly.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { FileOps, NormalizedBlock } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { formatFileList } from "../extract/files";
import { MAX_DECISIONS } from "../extract/user-decisions";
import {
  keepNewestUserMessages,
  EARLY_REQUESTS_KEPT,
} from "../extract/user-messages";
import { COMMAND_SEPARATOR, COMMANDS_PER_NAME } from "../extract/tracked-commands";
import { selectRankedBriefBlocks, type BriefRankingOptions } from "./rank";
import {
  formatSummary,
  capBrief,
  capItems,
  stripCapMarker,
  BRIEF_MAX_LINES,
  RECALL_NOTE,
  wrapLongLines,
} from "./format";

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  fileOps?: FileOps;
  /**
   * Raw (pre-convertToLlm) session messages for file-touch attribution.
   * Falls back to `messages` when omitted. bashExecution messages only exist
   * in the raw form, so passing these preserves bash mutation tracking.
   */
  touchMessages?: Message[];
  /** Working directory — merges relative/absolute file references. */
  cwd?: string;
  /** Git working-tree tags for fresh-window annotations (abs path → tag). */
  gitTags?: Map<string, string>;
  /**
   * Session-global `#N` index per message position (see
   * src/core/global-indices.ts). Parallel to `messages`; a missing entry
   * renders as no ref (fail-closed). Omitted entirely → legacy positional.
   */
  sourceIndices?: Array<number | undefined>;
  /** Command names to record in a [Tracked Commands] section; empty/omitted
   * = section stays empty. Threaded from config.trackCommands by the hook. */
  trackCommands?: readonly string[];
}

export interface RankedCompileInput extends CompileInput {
  /** Brief budget, char-denominated. The hook derives these from the
   * session's calibrated charsPerToken (core/token-estimate.ts), exactly as
   * upstream pi-vcc does; see RANKED_BRIEF_* in hooks/before-compact.ts. */
  ranking?: BriefRankingOptions;
}

const EARLY = "Early Session Requests";
const HEADER_NAMES = [
  EARLY,
  "Files And Changes",
  "Commits",
  "Tracked Commands",
  "User Messages",
  "User Decisions",
];

const SEPARATOR = "\n\n---\n\n";

// ── Shape-based header extraction ─────────────────────────────────────────
// A header is a "[Title Case]" line standing alone in the head area (the text
// before the first separator) plus the lines up to the next blank line. The
// brief transcript's blocks are "[user]" / "[assistant]", and a transcript
// line can start with "[Some Title]" followed by more text, so a header is
// never found by searching the text for "[Title]". (Upstream #60.)
const HEADER_LINE_RE = /^\[[A-Z][^\]\n]*\]$/;

const splitSummary = (text: string): { head: string; brief: string } => {
  if (!HEADER_LINE_RE.test(text.split("\n", 1)[0])) return { head: "", brief: text.trim() };
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return { head: text, brief: "" };
  return { head: text.slice(0, idx), brief: text.slice(idx + SEPARATOR.length).trim() };
};

/** Extract a named section from summary text (head area only). */
export const sectionOf = (text: string, header: string): string => {
  const lines = splitSummary(text).head.split("\n");
  const start = lines.indexOf(`[${header}]`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== "") end++;
  return lines.slice(start, end).join("\n").trim();
};

export const briefOf = (text: string): string => splitSummary(text).brief;

const isClean = (l: string) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");

// Both summaries went through wrapLongLines (the fresh one in formatSummary);
// rejoin each item's indented continuation lines so the merges, which read
// only "- " lines, see whole items.
const unwrapSection = (text: string, header: string) =>
  sectionOf(text, header).replace(/\n[ \t]+(?=\S)/g, " ");

/**
 * The previous summary's early requests, kept as they are: the first summary
 * sets them. An older version's [Session Goal] gives its first real line
 * (not a "- [skill: x]" / "- [Scope change]" marker).
 */
const pinnedEarlyRequests = (prev: string): string[] => {
  const early = unwrapSection(prev, EARLY).split("\n").filter(isClean);
  if (early.length > 0) return early.slice(0, EARLY_REQUESTS_KEPT);
  const goal = unwrapSection(prev, "Session Goal")
    .split("\n")
    .find((l) => isClean(l) && !/^- \[[^\]]*\]$/.test(l));
  return goal ? [goal] : [];
};

const COMMITS_CAP = 8;
const COMMIT_HASH_RE = /^- [0-9a-f]{7,12}: /;
const bareCommit = (line: string): string => line.replace(COMMIT_HASH_RE, "- ");

/** One line per commit, first-seen order. A hashless line is the same commit
 * as a hashed line with its message (one side did not capture the hash): keep
 * the hashed one, in the earlier line's place. */
const dedupCommitLines = (lines: string[]): string[] => {
  const out: string[] = [];
  for (const line of lines) {
    if (out.includes(line)) continue;
    const bare = bareCommit(line);
    if (COMMIT_HASH_RE.test(line)) {
      const hashless = out.findIndex((o) => o === bare);
      if (hashless >= 0) out[hashless] = line;
      else out.push(line);
    } else if (!out.some((o) => bareCommit(o) === bare)) {
      out.push(line);
    }
  }
  return out;
};

/**
 * Section mergers. Each merger receives the FULL previous and fresh summary
 * texts and extracts its own section — one entry point per header, declared
 * alongside the header list, so a section can never be merged by the wrong
 * policy (the failure mode this replaced: fall-through to the Commits merge).
 */
type SectionMerger = (prevText: string, freshText: string) => string;

const sectionLines = (sectionText: string): string[] =>
  sectionText.split("\n").filter(isClean);

/** Dedup + newest-cap merger shared by the line-list sections. */
const lineListMerger = (
  header: string,
  dedupeLines: (lines: string[]) => string[],
  cap: number,
): SectionMerger =>
  (prevText, freshText) => {
    const prevSec = unwrapSection(prevText, header);
    const freshSec = unwrapSection(freshText, header);
    if (!prevSec) return freshSec;
    if (!freshSec) return prevSec;
    const capped = dedupeLines([
      ...sectionLines(prevSec),
      ...sectionLines(freshSec),
    ]).slice(-cap);
    return capped.length === 0 ? "" : `[${header}]\n${capped.join("\n")}`;
  };

/**
 * Generic categorized-section merge: parses "- Category: a, b, c (+N more)"
 * lines from both prev and fresh text, unions each category's items across
 * compactions (deduped via Set), and re-renders. (Upstream.)
 */
const mergeCategorizedLines = (
  categories: readonly string[],
  prev: string,
  fresh: string,
  splitOn: string,
  touchOnDup = false,
): Record<string, Set<string>> => {
  const merged: Record<string, Set<string>> = {};
  for (const cat of categories) merged[cat] = new Set();

  for (const text of [prev, fresh]) {
    for (const line of text.split("\n")) {
      for (const cat of categories) {
        const prefix = `- ${cat}: `;
        if (!line.startsWith(prefix)) continue;
        // Strip the overflow marker so it never merges back in as an entry.
        const rest = stripCapMarker(line.slice(prefix.length));
        for (const p of rest.split(splitOn)) {
          const trimmed = p.trim();
          if (!trimmed) continue;
          // touchOnDup: re-inserting an existing entry moves it to the
          // tail — with tail-capping this makes the section "N most-
          // recently-USED" rather than "N most-recently-first-seen".
          if (touchOnDup && merged[cat].has(trimmed)) merged[cat].delete(trimmed);
          merged[cat].add(trimmed);
        }
      }
    }
  }
  return merged;
};

const formatCategorizedLines = (
  header: string,
  merged: Record<string, Set<string>>,
  categories: readonly string[],
  joinWith: string,
  itemLimit: number,
): string => {
  const lines: string[] = [];
  for (const cat of categories) {
    if (merged[cat].size > 0)
      lines.push(`- ${cat}: ${capItems([...merged[cat]], itemLimit, joinWith)}`);
  }
  if (lines.length === 0) return "";
  return `[${header}]\n${lines.join("\n")}`;
};

/** Category names actually present in "- <name>: ..." lines in `text`. */
const discoverCategoryNames = (text: string): string[] => {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^- ([^:]+): /);
    if (m) names.add(m[1]);
  }
  return [...names];
};

/**
 * Merge Tracked Commands by whatever command names actually appear in prev/
 * fresh (not a fixed category list, since trackCommands is user-config).
 * Line format (separator, cap) is owned by extract/tracked-commands.ts.
 */
const mergeTrackedCommandLines = (prev: string, fresh: string): string => {
  const categories = [
    ...new Set([...discoverCategoryNames(prev), ...discoverCategoryNames(fresh)]),
  ];
  const merged = mergeCategorizedLines(
    categories,
    prev,
    fresh,
    COMMAND_SEPARATOR,
    true,
  );
  return formatCategorizedLines(
    "Tracked Commands",
    merged,
    categories,
    COMMAND_SEPARATOR,
    COMMANDS_PER_NAME,
  );
};

/**
 * One merger per header, keyed by the exact HEADER_NAMES list. The loop in
 * mergePrevious looks each header up here and throws on a missing entry —
 * a section can never be merged by the wrong policy (the failure mode this
 * replaced: fall-through to the Commits merge for Early Session Requests).
 */
const SECTION_MERGERS: Record<string, SectionMerger> = {
  // Early requests are set once by the first summary and pinned forever
  // (including the legacy [Session Goal] migration); the fresh side is
  // ignored while pinned and used verbatim when nothing is pinned.
  [EARLY]: (prevText, freshText) => {
    const pinned = pinnedEarlyRequests(prevText);
    if (pinned.length > 0) return `[${EARLY}]\n${pinned.join("\n")}`;
    return unwrapSection(freshText, EARLY);
  },
  // Files merge parses its own section text; mergeFileLines understands both
  // blackhole's multi-line list shape and the upstream single-line shape,
  // so summaries written by any version merge correctly.
  "Files And Changes": (prevText, freshText) =>
    mergeFileLines(
      sectionOf(prevText, "Files And Changes"),
      sectionOf(freshText, "Files And Changes"),
    ),
  "Tracked Commands": (prevText, freshText) =>
    mergeTrackedCommandLines(
      unwrapSection(prevText, "Tracked Commands"),
      unwrapSection(freshText, "Tracked Commands"),
    ),
  "User Messages": (prevText, freshText) => {
    const prevSec = unwrapSection(prevText, "User Messages");
    const freshSec = unwrapSection(freshText, "User Messages");
    if (!prevSec) return freshSec;
    if (!freshSec) return prevSec;
    return `[User Messages]\n${keepNewestUserMessages([
      ...sectionLines(prevSec),
      ...sectionLines(freshSec),
    ]).join("\n")}`;
  },
  Commits: lineListMerger("Commits", dedupCommitLines, COMMITS_CAP),
  "User Decisions": lineListMerger(
    "User Decisions",
    (lines) => [...new Set(lines)],
    MAX_DECISIONS,
  ),
};

/**
 * Git word-tag suffix appended by the fresh compile ("src/a.ts (staged)").
 * Tags from the previous summary are stripped (stale point-in-time state);
 * fresh-window tags survive.
 */
const GIT_TAG_SUFFIX_RE =
  /\s+\((?:staged|unstaged|new|renamed|deleted|conflicted|staged,unstaged)\)\s*$/;

const addEntries = (
  merged: Record<string, Map<string, string>>,
  cat: string,
  isFresh: boolean,
  rest: string,
): void => {
  const text = rest.replace(/\s*\(\+\d+ more\)\s*$/, "");
  if (!text.trim()) return;
  const parts = text.split(/,(?![^()]*\))/);
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const key = trimmed.replace(GIT_TAG_SUFFIX_RE, "");
    const map = merged[cat];
    if (!map.has(key)) {
      map.set(key, isFresh ? trimmed : key);
    }
  }
};

/** Last top-level comma ends the text (only whitespace after it). */
const endsWithTopLevelComma = (s: string): boolean => {
  let lastComma = -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) lastComma = i;
  }
  return lastComma >= 0 && s.slice(lastComma + 1).trim().length === 0;
};

const appendFragment = (fragment: string, next: string): string => {
  if (fragment.length === 0) return next;
  if (/\s/.test(fragment) || /\(\+?\d*$/.test(fragment)) return `${fragment} ${next}`;
  return fragment + next;
};

export const mergeFileLines = (prev: string, fresh: string): string => {
  const categories = ["Modified", "Created", "Read"] as const;
  const merged: Record<string, Map<string, string>> = {};
  for (const cat of categories) merged[cat] = new Map();

  const totals: Record<string, number> = {};
  const bumpTotal = (cat: string, n: number): void => {
    if (Number.isFinite(n) && n > (totals[cat] ?? 0)) totals[cat] = n;
  };

  const headerRe = /^- (Modified|Created|Read)( \(\d+\))?:(.*)$/;
  const moreRe = /^\(\+\d+ more\)$/;
  for (const text of [fresh, prev]) {
    const isFresh = text === fresh;
    let current: string | null = null;
    let fragment = "";
    let listed = 0;
    const flush = (): void => {
      if (current === null || !fragment.trim()) {
        fragment = "";
        return;
      }
      const more = fragment.match(/\(\+(\d+) more\)\s*$/);
      const body = more ? fragment.slice(0, more.index) : fragment;
      const parts = body.split(/,(?![^()]*\))/).filter((p) => p.trim());
      listed += parts.length;
      if (more) bumpTotal(current, parts.length + Number(more[1]));
      addEntries(merged, current, isFresh, fragment);
      fragment = "";
    };
    for (const line of text.split("\n")) {
      const header = line.match(headerRe);
      if (header) {
        flush();
        current = header[1];
        if (header[2]) bumpTotal(current, Number.parseInt(header[2].replace(/\D/g, ""), 10));
        fragment = header[3];
        if (endsWithTopLevelComma(fragment)) flush();
        continue;
      }
      if (current === null) continue;
      if (!line.startsWith(" ") && !line.startsWith("\t")) {
        if (line.trim()) {
          flush();
          current = null;
        }
        continue;
      }
      const entry = line.trim();
      if (!entry || moreRe.test(entry)) {
        const more = entry.match(/^\(\+(\d+) more\)$/);
        if (more && current !== null) bumpTotal(current, listed + Number(more[1]));
        continue;
      }
      fragment = appendFragment(fragment, entry);
      if (endsWithTopLevelComma(fragment)) flush();
    }
    flush();
  }

  // Dedup: if already in Modified, drop from Created (file existed before)
  for (const key of merged.Modified.keys()) merged.Created.delete(key);
  // Also remove Read entries that also appear in Modified (same file read+edited)
  for (const key of merged.Modified.keys()) merged.Read.delete(key);

  const preservedTotal = (cat: string): number => Math.max(totals[cat] ?? 0, merged[cat].size);

  const lines: string[] = [];
  if (merged.Modified.size > 0)
    lines.push(
      `- ${formatFileList("Modified", [...merged.Modified.values()], 20, preservedTotal("Modified"))}`,
    );
  if (merged.Created.size > 0)
    lines.push(
      `- ${formatFileList("Created", [...merged.Created.values()], 20, preservedTotal("Created"))}`,
    );
  if (merged.Read.size > 0) {
    const arr = [...merged.Read.values()];
    const readTotal = preservedTotal("Read");
    lines.push(
      `- Read: ${arr.slice(0, 10).join(", ")}${readTotal > 10 ? ` (+${readTotal - 10} more)` : ""}`,
    );
  }
  if (lines.length === 0) return "";
  return `[Files And Changes]\n${lines.join("\n")}`;
};

const briefLineCount = (text: string): number => (text ? text.split("\n").length : 0);

const capBriefToLineBudget = (text: string, maxLines: number): string => {
  if (!text || maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(-maxLines);
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  const omitted = lines.length - clean.length;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

/** Unranked merge: prev brief + fresh brief (compile() caps the total). */
const mergeBriefTranscript = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return prev;
  return prev + "\n\n" + fresh;
};

/** Fresh brief is budget-selected; charge it against the 120-line rolling
 * window so the merged brief cannot grow unboundedly across compactions. */
const mergeBriefTranscriptWithFreshBudget = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return capBrief(prev);
  const freshLines = briefLineCount(fresh);
  const remainingPrevLines = Math.max(0, BRIEF_MAX_LINES - freshLines);
  const prevTail = capBriefToLineBudget(prev, remainingPrevLines);
  return prevTail ? `${prevTail}\n\n${fresh}` : fresh;
};

const mergePrevious = (
  prev: string,
  fresh: string,
  options: { preserveFreshBrief?: boolean } = {},
): string => {
  const headers = HEADER_NAMES.map((header) => {
    const merger = SECTION_MERGERS[header];
    if (!merger)
      throw new Error(`summarize: no merger registered for section [${header}]`);
    return merger(prev, fresh);
  }).filter(Boolean);

  const prevBrief = briefOf(prev);
  const freshBrief = briefOf(fresh);
  const mergedBrief = options.preserveFreshBrief
    ? mergeBriefTranscriptWithFreshBudget(prevBrief, freshBrief)
    : mergeBriefTranscript(prevBrief, freshBrief);

  const parts: string[] = [];
  if (headers.length > 0) {
    parts.push(headers.join("\n\n"));
  }
  if (mergedBrief) {
    parts.push(options.preserveFreshBrief ? mergedBrief : capBrief(mergedBrief));
  }

  return parts.join(SEPARATOR);
};

interface CompileOptions {
  /** Selects the brief blocks (ranked path); omitted = unranked full window. */
  briefBlocksFor?: (blocks: ReturnType<typeof normalize>) => NormalizedBlock[];
  capFreshBrief: boolean;
  preserveFreshBriefOnMerge: boolean;
}

const compileWithBrief = (
  input: CompileInput,
  options: CompileOptions,
): string => {
  const blocks = filterNoise(normalize(input.messages, input.sourceIndices));
  const briefBlocks = options.briefBlocksFor?.(blocks);
  const data = buildSections({
    blocks,
    briefBlocks,
    messages: input.touchMessages ?? input.messages,
    fileOps: input.fileOps,
    cwd: input.cwd,
    gitTags: input.gitTags,
    trackCommands: input.trackCommands,
    hasEarlyRequests:
      input.previousSummary !== undefined &&
      pinnedEarlyRequests(input.previousSummary).length > 0,
  });
  // The ranked brief carries its own char budget; do not also cap by lines.
  return formatSummary(data, { capBriefTranscript: options.capFreshBrief });
};

/** Build one fresh immutable VCC segment. It never reads an older summary.
 * Pass `ranking` to select the brief by signal density (append mode). */
export const compileSegment = (input: RankedCompileInput): string => {
  const fresh = input.ranking
    ? compileWithBrief(input, rankedOptions(input))
    : compileWithBrief(input, unrankedOptions);
  return fresh ? wrapLongLines(fresh) : "";
};

const unrankedOptions: CompileOptions = {
  capFreshBrief: true,
  preserveFreshBriefOnMerge: false,
};

const rankedOptions = (input: RankedCompileInput): CompileOptions => ({
  briefBlocksFor: (blocks) =>
    selectRankedBriefBlocks(blocks, {
      ...input.ranking,
      fileOps: input.ranking?.fileOps ?? input.fileOps,
    }),
  capFreshBrief: false,
  preserveFreshBriefOnMerge: true,
});

/** Unranked compile: fixed rolling brief cap, upstream-legacy path. */
export const compile = (input: CompileInput): string =>
  compileWithPrev(input, unrankedOptions);

/** Signal-density-ranked compile: the path the hook uses, with the brief
 * budget converted from the session's calibrated charsPerToken upstream's
 * RANKED_BRIEF_* constants (see hooks/before-compact.ts). */
export const compileRanked = (input: RankedCompileInput): string =>
  compileWithPrev(input, rankedOptions(input));

const compileWithPrev = (input: CompileInput, options: CompileOptions): string => {
  const fresh = compileWithBrief(input, options);

  // Strip OM content first (## Reflections / ## Observations + preamble),
  // then strip ALL recall notes from the previous summary using paragraph-level
  // matching. Order matters: OM sections appear before the recall note in the
  // stored summary, so we must remove them first to avoid leaving the recall
  // stripper with fragments.
  let prev = input.previousSummary ? stripOMContent(input.previousSummary) : undefined;
  prev = prev ? stripRecallNotes(prev) : undefined;
  const merged = prev ? mergePrevious(prev, fresh, { preserveFreshBrief: options.preserveFreshBriefOnMerge }) : fresh;
  if (!merged) return "";
  // Defensive: remove any recall notes that survived the above (e.g. nested
  // inside the brief transcript after a prior merge).
  const cleaned = stripRecallNotes(merged);
  return wrapLongLines(cleaned + SEPARATOR + RECALL_NOTE);
};

/**
 * Strip ALL recall-note paragraphs from text using paragraph-level matching.
 *
 * The recall note is identified by the sentence:
 *   "The conversation before this point has been compacted"
 *
 * After wrapLongLines runs, the recall note may be split across multiple lines,
 * so exact string matching against RECALL_NOTE fails. Instead, split the text
 * into paragraphs (double-newline boundaries) and drop any paragraph that
 * contains the identifying sentence.
 */
const RECALL_NOTE_MARKER = "The conversation before this point has been compacted";

/** Return the one mutable recall-note paragraph from a complete summary. */
export const extractRecallNote = (text: string): string =>
  text
    .split(/\n\n+/)
    .find((paragraph) => paragraph.includes(RECALL_NOTE_MARKER))
    ?.trim() ?? "";

export const stripRecallNotes = (text: string): string => {
  const paragraphs = text.split(/\n\n+/);
  const kept = paragraphs.filter((p) => !p.includes(RECALL_NOTE_MARKER));
  return kept.join("\n\n");
};

export const stripOMContent = (text: string): string => {
  // Remove everything from "## Reflections" or "## Observations" onward,
  // plus the instructions preamble that precedes them.
  // The preamble starts with "These are condensed memories from earlier in this session."
  // Use line-start anchoring to avoid matching inside conversation content
  const reflMatch = text.match(/^## Reflections/m);
  const reflIdx = reflMatch ? reflMatch.index! : -1;
  const obsMatch = text.match(/^## Observations/m);
  const obsIdx = obsMatch ? obsMatch.index! : -1;

  // Also detect the basic recall-guidance footer (no observation preamble)
  const basicFooterIdx = text.indexOf(
    "Use `recall` with an id to retrieve original context, or `#N:path` drill-down",
  );

  // Find the start of OM content: either the instructions preamble or the first section header
  let stripFrom = -1;
  if (reflIdx >= 0 || obsIdx >= 0) {
    const preambleIdx = text.indexOf("These are condensed memories from earlier in this session.");
    const minSectionIdx = Math.min(
      reflIdx >= 0 ? reflIdx : Infinity,
      obsIdx >= 0 ? obsIdx : Infinity,
    );
    // Old format: preamble before sections -> strip from preamble.
    // New format: preamble after sections -> strip from first section header.
    if (preambleIdx >= 0 && preambleIdx < minSectionIdx) {
      stripFrom = preambleIdx;
    } else if (minSectionIdx < Infinity) {
      stripFrom = minSectionIdx;
    }
  } else if (basicFooterIdx >= 0) {
    // Strip the basic recall-guidance footer (no observations/reflections present)
    stripFrom = basicFooterIdx;
  }

  if (stripFrom < 0) return text;

  // Also strip any trailing separators before the OM content
  let end = stripFrom;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  // Strip trailing "---" separator if present
  const beforeEnd = text.slice(0, end).trimEnd();
  if (beforeEnd.endsWith("---")) {
    return beforeEnd.slice(0, beforeEnd.length - 3).trimEnd();
  }
  return beforeEnd;
};
