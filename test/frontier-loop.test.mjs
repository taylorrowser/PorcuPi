import assert from "node:assert/strict";
import test from "node:test";
import { findFrontier, validationPassed } from "../scripts/frontier-loop.mjs";

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
