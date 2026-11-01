import type { SectionData } from "../sections";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

const section = (title: string, items: string[]): string => {
  if (items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]\n${body}`;
};

/**
 * Join a categorized line's items (oldest first), keeping the newest `limit`
 * behind a leading "(+N earlier)". Keeping the oldest instead froze a merged
 * list on its first entries. stripCapMarker is its inverse, used when a merge
 * re-reads the line. (Ported from upstream pi-vcc src/core/format.ts.)
 */
export const capItems = (items: readonly string[], limit: number, joinWith: string): string => {
  if (items.length <= limit) return items.join(joinWith);
  return `(+${items.length - limit} earlier) ` + items.slice(-limit).join(joinWith);
};

/** Files listed per Files And Changes category; the newest are kept. */
export const FILES_PER_CATEGORY = 10;

/** Also strips the trailing "(+N more)" that older versions wrote. */
export const stripCapMarker = (text: string): string =>
  text.replace(/^\s*\(\+\d+ earlier\)\s*/, "").replace(/\s*\(\+\d+ (?:more|earlier)\)\s*$/, "");

export const BRIEF_MAX_LINES = 120;
const TUI_SAFE_LINE_CHARS = 120;

/**
 * Wrap a single line of text, preserving list-item continuation indent.
 * Detects leading bullets (-, *, N.) and indents continuation lines
 * to match, so wrapped list items remain visually grouped.
 */
function wrapLineWithContinuation(line: string, maxChars: number): string[] {
  const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
  const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
  // Wrap at reduced width so prepending continuationIndent doesn't exceed maxChars
  const safeMaxChars = continuationIndent ? maxChars - continuationIndent.length : maxChars;
  const wrapped = wrapTextWithAnsi(line, safeMaxChars);
  if (wrapped.length <= 1 || !continuationIndent) return wrapped;
  return [wrapped[0], ...wrapped.slice(1).map((l) => continuationIndent + l)];
}

export const wrapLongLines = (text: string, maxChars = TUI_SAFE_LINE_CHARS): string =>
  text
    .split("\n")
    .flatMap((line) => wrapLineWithContinuation(line, maxChars))
    .join("\n");

export const capBrief = (text: string): string => {
  const lines = text.split("\n");
  if (lines.length <= BRIEF_MAX_LINES) return text;
  const kept = lines.slice(-BRIEF_MAX_LINES);
  // Find first section header to avoid cutting mid-section
  let firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  if (firstHeader < 0) {
    // No header in the kept window — scan for any bracket-delimited anchor
    // (e.g., tool name, inline reference) to avoid starting mid-paragraph.
    const anyAnchor = kept.findIndex((l) => /^\[[^\]]+\]/.test(l));
    if (anyAnchor > 0) firstHeader = anyAnchor;
  }
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  const omitted = lines.length - clean.length;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

export const RECALL_NOTE =
  "The conversation before this point has been compacted into the summary above. " +
  "Details not captured here — exact code, error messages, file paths — are only recoverable via `recall`. " +
  "Use `recall` to search the session history. Do not redo work already completed.";

export interface FormatSummaryOptions {
  capBriefTranscript?: boolean;
}

export const formatSummary = (data: SectionData, options: FormatSummaryOptions = {}): string => {
  const capBriefTranscript = options.capBriefTranscript ?? true;
  const headerParts = [
    section("Early Session Requests", data.earlyRequests),
    section("Files And Changes", data.filesAndChanges),
    section("Commits", data.commits),
    section("Tracked Commands", data.trackedCommands),
    section("User Messages", data.userMessages),
    section("User Decisions", data.userDecisions),
  ].filter(Boolean);

  const parts: string[] = [];
  if (headerParts.length > 0) {
    parts.push(headerParts.join("\n\n"));
  }
  if (data.briefTranscript) {
    parts.push(capBriefTranscript ? capBrief(data.briefTranscript) : data.briefTranscript);
  }

  if (parts.length === 0) return "";

  // NOTE: RECALL_NOTE is appended by compile(), not here.
  // It is appended once by `compile()` at the very end, after merge-with-previous,
  // to avoid the note compounding inside the brief transcript across compactions.
  return wrapLongLines(parts.join("\n\n---\n\n"));
};
