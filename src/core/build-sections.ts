/**
 * Section building — parses normalized blocks into structured sections.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/core/build-sections.ts)
 * at the 0.11.0 section redesign (verbatim early requests / user messages
 * replace the old keyword-picked Session Goal / Preferences / Outstanding
 * Context). pi-blackhole modifications kept:
 * - Files And Changes also attributes files from raw session messages via
 *   the file-touch collector (src/extract/file-touch.ts), covering anchor-
 *   based edit tools and bash mutations that PATH_KEYS matching cannot see,
 *   plus git working-tree tags (src/extract/git-status.ts).
 * - [User Decisions] section from question-tool results
 *   (src/extract/user-decisions.ts).
 * - briefBlocks: the ranked-brief selection (core/rank.ts) feeds the brief
 *   while the full blocks still drive the other sections.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { FileOps, NormalizedBlock } from "../types";
import type { SectionData } from "../sections";
import { extractUserMessages, keepNewestUserMessages, EARLY_REQUESTS_KEPT } from "../extract/user-messages";
import { extractFiles, formatFileList } from "../extract/files";
import { collectFilesTouched } from "../extract/file-touch";
import { extractCommits, formatCommits } from "../extract/commits";
import { extractTrackedCommands, formatTrackedCommands } from "../extract/tracked-commands";
import { extractUserDecisions } from "../extract/user-decisions";
import { buildBriefSections, stringifyBrief } from "./brief";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  /** Blocks selected for the brief transcript (ranked); defaults to `blocks`. */
  briefBlocks?: NormalizedBlock[];
  /** Raw pre-convertToLlm session messages — enables file-touch attribution. */
  messages?: Message[];
  /** Working directory for relative-path merging in file-touch attribution. */
  cwd?: string;
  /** Pi's own file-op seed lists (read/written/edited). */
  fileOps?: FileOps;
  /** Git working-tree tags (abs path → "staged"/"new"/…), see src/extract/git-status.ts. */
  gitTags?: Map<string, string>;
  /** Command names to record in a [Tracked Commands] section (see
   * config trackCommands). Empty/omitted = section stays empty. */
  trackCommands?: readonly string[];
  /** The previous summary already holds the early requests, so this
   * compaction's first messages are ordinary user messages. */
  hasEarlyRequests?: boolean;
}

const formatFileActivity = (input: BuildSectionsInput): string[] => {
  // Lazy: the touch collector only runs at compaction time, never per tool call.
  const touched = input.messages ? collectFilesTouched(input.messages, input.cwd) : [];
  const act = extractFiles(input.blocks, input.fileOps, touched, input.gitTags, input.cwd);
  // Dedup: if already Modified, drop from Created (file existed before)
  for (const p of act.modified) act.created.delete(p);
  const lines: string[] = [];
  const tagOf = (p: string): string => {
    const tag = act.gitTags?.get(p);
    return tag ? ` (${tag})` : "";
  };
  // Modified/Created render as one-per-line lists (up to 20 — the touched
  // set is the session's ground truth, worth preserving); Read stays a
  // comma-joined bullet capped at 10.
  const list = (set: Set<string>) => [...set].map((p) => `${p}${tagOf(p)}`);
  if (act.modified.size > 0) lines.push(formatFileList("Modified", list(act.modified), 20));
  if (act.created.size > 0) lines.push(formatFileList("Created", list(act.created), 20));
  if (act.read.size > 0) {
    const arr = list(act.read);
    lines.push(
      `Read: ${arr.slice(0, 10).join(", ")}${arr.length > 10 ? ` (+${arr.length - 10} more)` : ""}`,
    );
  }
  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const briefSections = buildBriefSections(input.briefBlocks ?? blocks);
  // The early requests are the session's first user messages, picked by
  // position; they are not repeated in [User Messages].
  const messages = extractUserMessages(blocks);
  const early = input.hasEarlyRequests ? [] : messages.slice(0, EARLY_REQUESTS_KEPT);
  return {
    earlyRequests: early,
    filesAndChanges: formatFileActivity(input),
    commits: formatCommits(extractCommits(blocks)),
    trackedCommands: formatTrackedCommands(
      extractTrackedCommands(blocks, input.trackCommands ?? []),
    ),
    userMessages: keepNewestUserMessages(messages.slice(early.length)),
    userDecisions: extractUserDecisions(blocks),
    briefTranscript: stringifyBrief(briefSections),
  };
};
