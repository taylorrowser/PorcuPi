import assert from "node:assert/strict";
import test from "node:test";
import {
  failureBaseState,
  findFrontier,
  panesAreRunning,
  parsePullRequestNumber,
  shouldDiagnoseResume,
  validationFailureAction,
  validationPassed,
} from "../scripts/frontier-loop.mjs";

function issue(number, { state = "OPEN", assignees = [], blockedBy = [] } = {}) {
  return { number, title: `Issue ${number}`, state, assignees, blockedBy };
}

test("frontier selects the first open unassigned issue whose blockers are closed", () => {
  const issues = [
    issue(44, { blockedBy: [{ number: 43, state: "OPEN" }] }),
    issue(43, { assignees: [{ login: "worker" }] }),
    issue(42, { blockedBy: [{ number: 41, state: "CLOSED" }] }),
    issue(41, { state: "CLOSED" }),
  ];

  assert.equal(findFrontier(issues)?.number, 42);
});

test("frontier is absent when every remaining issue is assigned or blocked", () => {
  const issues = [
    issue(41, { assignees: [{ login: "worker" }] }),
    issue(42, { blockedBy: [{ number: 41, state: "OPEN" }] }),
  ];

  assert.equal(findFrontier(issues), undefined);
});

test("validation requires the final explicit reviewer verdict", () => {
  assert.equal(validationPassed("Everything passes.\nVALIDATION: PASS\n"), true);
  assert.equal(validationPassed("VALIDATION: PASS\nLater finding.\nVALIDATION: FAIL\n"), false);
  assert.equal(validationPassed("The implementation looks good."), false);
});

test("pull request URLs yield their numeric GitHub identity", () => {
  assert.equal(parsePullRequestNumber("https://github.com/taylorrowser/PorcuPi/pull/58"), 58);
  assert.throws(() => parsePullRequestNumber("https://github.com/taylorrowser/PorcuPi/issues/58"), /pull request URL/);
});

test("failure reporting preserves the latest state written by nested processing", () => {
  const stale = { currentIssue: null, phase: "starting" };
  const persisted = { currentIssue: 41, phase: "merging", worktree: "/tmp/issue-41" };

  assert.deepEqual(failureBaseState(stale, persisted), persisted);
  assert.deepEqual(failureBaseState(stale, null), stale);
});

test("a tmux session is running only while at least one pane is live", () => {
  assert.equal(panesAreRunning(["1"]), false);
  assert.equal(panesAreRunning(["1", "0"]), true);
  assert.equal(panesAreRunning([]), false);
});

test("validation exhaustion escalates to an independent diagnostic instance", () => {
  assert.equal(validationFailureAction({ attempt: 1, maximumAttempts: 3, diagnosticEscalations: 0, maximumDiagnosticEscalations: 2 }), "remediate");
  assert.equal(validationFailureAction({ attempt: 3, maximumAttempts: 3, diagnosticEscalations: 0, maximumDiagnosticEscalations: 2 }), "diagnose");
  assert.equal(validationFailureAction({ attempt: 3, maximumAttempts: 3, diagnosticEscalations: 2, maximumDiagnosticEscalations: 2 }), "fail");
});

test("a preserved validation failure resumes with diagnosis instead of another implementation pass", () => {
  assert.equal(shouldDiagnoseResume({ phase: "failed", lastError: "Validation failed 3 times for #45" }), true);
  assert.equal(shouldDiagnoseResume({ phase: "failed", lastError: "Remote checks failed for PR #45" }), false);
  assert.equal(shouldDiagnoseResume({ phase: "validating", lastError: null }), false);
});
