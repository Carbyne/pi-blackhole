import { compileRanked } from "../src/core/summarize";

// The hook calibrates charsPerToken from harness tokensBefore; the smoke
// pins the heuristic value explicitly — same contract, deterministic input.
const RANKING = {
  maxBriefChars: 1100 * 4,
  maxBriefCharsCeiling: 2000 * 4,
  briefCharsPerBlock: 15 * 4,
};

const m = (o: Record<string, unknown>) => o as never;

const messages1 = [
  m({ role: "user", content: "Fix the auth bug, users can't log in after password reset", timestamp: 1 }),
  m({
    role: "assistant",
    content: [
      { type: "text", text: "Root cause is a missing token refresh after password reset. I will patch the session module." },
      { type: "toolCall", id: "t1", name: "edit", arguments: { path: "src/auth/session.ts", oldText: "const a = 1", newText: "const a = 2" } },
    ],
    timestamp: 2,
  }),
  m({ role: "toolResult", toolName: "edit", content: [{ type: "text", text: "Ok" }], isError: false, timestamp: 3 }),
  m({
    role: "assistant",
    content: [
      { type: "toolCall", id: "t2", name: "bash", arguments: { command: 'git commit -am "fix(auth): refresh token after password reset"' } },
    ],
    timestamp: 4,
  }),
  m({ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "[main a1b2c3d] fix(auth): refresh token after password reset" }], isError: false, timestamp: 5 }),
  m({
    role: "assistant",
    content: [
      { type: "toolCall", id: "t3", name: "bash", arguments: { command: 'git commit -q -m "chore: bump version"' } },
    ],
    timestamp: 6,
  }),
  m({ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "" }], isError: false, timestamp: 6.5 }),
  m({
    role: "assistant",
    content: [
      { type: "toolCall", id: "t4", name: "bash", arguments: { command: "kubectl get pods -n prod" } },
    ],
    timestamp: 7,
  }),
  m({ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "NAME READY\napi-1 1/1" }], isError: false, timestamp: 8 }),
  m({ role: "user", content: "Always run tests before committing", timestamp: 8 }),
  // Simulates the hook's custom_message handling: an extension-injected
  // message arrives as a user-role message marked `injected` — it must render
  // in the transcript but never read as the user's own words in the sections.
  m({ role: "user", content: "JOB COMPLETE: nightly sync finished", injected: true, timestamp: 8.5 } as never),
  m({ role: "assistant", content: [{ type: "text", text: "Understood — running bun test now." }], timestamp: 9 }),
];

// Realistic second compaction: the hook passes only the NEW window after the
// first cut, with previousSummary carrying everything before it.
const messages2 = [m({ role: "user", content: "Also update the session token refresh logic to use JWT rotation", timestamp: 10 })];

const s1 = compileRanked({
  messages: messages1,
  // Session-global index space: entries 0..10 are this window.
  sourceIndices: messages1.map((_, i) => i),
  trackCommands: ["git", "kubectl"],
  ranking: RANKING,
});
console.log("===== SUMMARY 1 =====");
console.log(s1);

const s2 = compileRanked({
  messages: messages2,
  // This window's single entry is session entry #12 (0..11 were summarized —
  // #10 is the injected message, #11 the last assistant reply).
  sourceIndices: [12],
  previousSummary: s1,
  trackCommands: ["git", "kubectl"],
  ranking: RANKING,
});
console.log("===== SUMMARY 2 (merged) =====");
console.log(s2);

// Hand-checkable gates
const checks: Array<[string, boolean]> = [
  ["S1 has Early Session Requests", s1.includes("[Early Session Requests]")],
  ["S1 early = first user message verbatim", s1.includes("- Fix the auth bug, users can't log in after password reset")],
  ["S1 has Files", s1.includes("[Files And Changes]") && s1.includes("src/auth/session.ts")],
  ["S1 has commit", s1.includes("a1b2c3d: fix(auth): refresh token after password reset")],
  ["S1 has tracked kubectl", s1.includes("[Tracked Commands]") && s1.includes("kubectl get pods -n prod")],
  ["S1 tracks git commit cmd too (dedup vs Commits section)", s1.includes("git commit -q -m") && s1.includes("chore: bump version")],
  ["S1 early holds BOTH user msgs (<=3 → all early, none in User Messages)", s1.includes("- Fix the auth bug, users can't log in after password reset") && s1.includes("- Always run tests before committing") && !s1.includes("[User Messages]")],
  ["S1 recall note present", s1.includes("The conversation before this point has been compacted")],
  ["S1 injected msg renders in transcript but not sections", s1.includes("JOB COMPLETE: nightly sync finished (#10)") && !s1.includes("- JOB COMPLETE")],
  ["S1 has no legacy sections", !s1.includes("[Session Goal]") && !s1.includes("[User Preferences]") && !s1.includes("[Outstanding Context]")],
  ["S2 keeps files across compactions", s2.includes("src/auth/session.ts")],
  ["S2 keeps early requests pinned (3)", s2.includes("- Fix the auth bug, users can't log in after password reset")],
  ["S2 absorbed new user msg into User Messages", s2.includes("Also update the session token refresh logic to use JWT rotation")],
  ["S2 commit appears once", (s2.match(/a1b2c3d: fix\(auth\)/g) || []).length === 1],
  ["S2 fresh ref continues the global index space", s2.includes("(#12)")],
  ["S2 single recall note", (s2.match(/The conversation before this point/g) || []).length === 1],
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) fail++;
}
console.log(fail === 0 ? "ALL GATES PASS" : `${fail} GATES FAILED`);
process.exit(fail === 0 ? 0 : 1);
