/**
 * Section shapes produced by buildSections and rendered by formatSummary.
 *
 * Upstream: https://github.com/sting8k/pi-vcc (src/sections.ts) — the 0.11.0
 * section redesign: keyword-picked [Session Goal] / [User Preferences] /
 * [Outstanding Context] replaced by verbatim [Early Session Requests] and
 * [User Messages] (language-independent: nothing is interpreted by English
 * wording). pi-blackhole additionally keeps [User Decisions] (confirmed
 * answers from question tools, src/extract/user-decisions.ts).
 */
export interface SectionData {
  earlyRequests: string[];
  filesAndChanges: string[];
  commits: string[];
  trackedCommands: string[];
  userMessages: string[];
  userDecisions: string[];
  briefTranscript: string;
}
