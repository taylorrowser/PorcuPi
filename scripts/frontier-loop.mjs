#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultParent = 40;
const defaultPollSeconds = 60;
const maximumAgentAttempts = 3;

function fail(message) {
  throw new Error(message);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.environment },
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  return result;
}

function commandOutput(command, args, options = {}) {
  const result = commandResult(command, args, options);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function commandJson(command, args, options = {}) {
  const output = commandOutput(command, args, options);
  return output ? JSON.parse(output) : null;
}

function ghJson(args, options = {}) {
  return commandJson("gh", [...args, "--json", options.fields], options);
}

function sleep(milliseconds) {
  execFileSync(process.execPath, ["-e", `setTimeout(() => {}, ${milliseconds})`]);
}

function isoNow() {
  return new Date().toISOString();
}

function loopPaths(parent) {
  const root = resolve(process.env.PORCUPI_FRONTIER_DIR ?? join(repositoryRoot, "artifacts", `frontier-loop-${parent}`));
  return {
    root,
    state: join(root, "status.json"),
    stop: join(root, "STOP"),
    runnerLog: join(root, "runner.log"),
    worktrees: join(root, "worktrees"),
  };
}

function sessionName(parent) {
  return process.env.PORCUPI_FRONTIER_SESSION ?? `porcupi-frontier-${parent}`;
}

function readState(paths) {
  if (!existsSync(paths.state)) return null;
  return JSON.parse(readFileSync(paths.state, "utf8"));
}

function writeState(paths, current, patch) {
  mkdirSync(paths.root, { recursive: true });
  const next = { ...current, ...patch, updatedAt: isoNow() };
  const temporary = `${paths.state}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.state);
  return next;
}

function log(message) {
  process.stdout.write(`[${isoNow()}] ${message}\n`);
}

export function findFrontier(issues) {
  return [...issues]
    .sort((left, right) => left.number - right.number)
    .find((issue) => issue.state === "OPEN" && issue.assignees.length === 0 && issue.blockedBy.every((blocker) => blocker.state === "CLOSED"));
}

export function validationPassed(output) {
  const verdicts = [...output.matchAll(/^VALIDATION:\s*(PASS|FAIL)\s*$/gim)];
  return verdicts.length > 0 && verdicts.at(-1)[1].toUpperCase() === "PASS";
}

export function parsePullRequestNumber(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`Invalid pull request URL: ${value}`);
  }
  const match = url.pathname.match(/^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/);
  if (!match) fail(`Invalid pull request URL: ${value}`);
  return Number(match[1]);
}

export function failureBaseState(inMemory, persisted) {
  return persisted ?? inMemory;
}

export function panesAreRunning(deadStatuses) {
  return deadStatuses.some((status) => status === "0");
}

function parentIssues(parent) {
  const parentData = ghJson(["issue", "view", String(parent)], { fields: "number,title,state,subIssues" });
  const children = parentData.subIssues?.nodes ?? [];
  return children.map((child) => {
    const detail = ghJson(["issue", "view", String(child.number)], { fields: "number,title,state,url,assignees,blockedBy,parent" });
    if (detail.parent?.number !== parent) fail(`Issue #${child.number} is no longer a child of #${parent}`);
    return {
      number: detail.number,
      title: detail.title,
      state: detail.state,
      url: detail.url,
      assignees: detail.assignees ?? [],
      blockedBy: detail.blockedBy?.nodes ?? [],
    };
  });
}

function viewerLogin() {
  return commandOutput("gh", ["api", "user", "--jq", ".login"]);
}

function defaultBranch() {
  return commandOutput("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
}

function ensurePrerequisites() {
  for (const [command, args] of [["tmux", ["-V"]], ["pi", ["--version"]], ["gh", ["auth", "status"]], ["git", ["--version"]], ["npm", ["--version"]]]) {
    const result = commandResult(command, args);
    if (result.status !== 0) fail(`Required command is unavailable or not configured: ${command}`);
  }
  const dirty = commandOutput("git", ["status", "--porcelain"]);
  if (dirty) fail("Refusing to start from a dirty control checkout. Commit and push the frontier-loop files and any planning docs first.");
  const branch = defaultBranch();
  commandOutput("git", ["fetch", "origin", branch]);
  let localHead = commandOutput("git", ["rev-parse", "HEAD"]);
  const remoteHead = commandOutput("git", ["rev-parse", `origin/${branch}`]);
  if (localHead !== remoteHead) {
    const canFastForward = commandResult("git", ["merge-base", "--is-ancestor", localHead, remoteHead]).status === 0;
    if (!canFastForward) fail(`Control checkout must be pushed or safely fast-forwardable to origin/${branch} before starting the autonomous merge loop.`);
    commandOutput("git", ["merge", "--ff-only", `origin/${branch}`]);
    localHead = commandOutput("git", ["rev-parse", "HEAD"]);
  }
  if (localHead !== remoteHead) fail(`Control checkout HEAD does not match origin/${branch} after fast-forward.`);
}

function tmuxSessionExists(parent) {
  return commandResult("tmux", ["has-session", "-t", sessionName(parent)]).status === 0;
}

function tmuxAlive(parent) {
  if (!tmuxSessionExists(parent)) return false;
  const result = commandResult("tmux", ["list-panes", "-t", sessionName(parent), "-F", "#{pane_dead}"]);
  return result.status === 0 && panesAreRunning(result.stdout.trim().split("\n").filter(Boolean));
}

function start(parent) {
  ensurePrerequisites();
  if (tmuxAlive(parent)) fail(`tmux session ${sessionName(parent)} is already running`);
  if (tmuxSessionExists(parent)) commandResult("tmux", ["kill-session", "-t", sessionName(parent)]);
  const paths = loopPaths(parent);
  mkdirSync(paths.worktrees, { recursive: true });
  rmSync(paths.stop, { force: true });
  const script = fileURLToPath(import.meta.url);
  const command = `exec ${shellQuote(process.execPath)} ${shellQuote(script)} run --parent ${parent}`;
  commandOutput("tmux", ["new-session", "-d", "-s", sessionName(parent), "-c", repositoryRoot, command]);
  commandOutput("tmux", ["set-option", "-t", sessionName(parent), "remain-on-exit", "on"]);
  commandOutput("tmux", ["pipe-pane", "-o", "-t", sessionName(parent), `cat >> ${shellQuote(paths.runnerLog)}`]);
  process.stdout.write(`Started ${sessionName(parent)}.\n`);
  process.stdout.write(`Check progress with: npm run frontier:status\n`);
  process.stdout.write(`Watch live with:      npm run frontier:attach\n`);
}

function appendAgentLog(path, heading, output = "") {
  appendFileSync(path, `\n===== ${heading} — ${isoNow()} =====\n${output}${output.endsWith("\n") || !output ? "" : "\n"}`);
}

function runAgent(worktree, prompt, logPath, heading) {
  const descriptor = openSync(logPath, "a");
  appendAgentLog(logPath, heading);
  const result = spawnSync("pi", ["-p", "--no-session", prompt], {
    cwd: worktree,
    env: process.env,
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  if (result.error) fail(`pi failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`pi exited ${result.status}; inspect ${logPath}`);
}

function validateWorktree(worktree, logPath) {
  const descriptor = openSync(logPath, "a");
  appendAgentLog(logPath, "independent command validation");
  for (const [command, args] of [
    ["npm", ["ci", "--ignore-scripts"]],
    ["npm", ["run", "check"]],
    ["npm", ["test"]],
  ]) {
    const result = spawnSync(command, args, { cwd: worktree, env: process.env, stdio: ["ignore", descriptor, descriptor] });
    if (result.error || result.status !== 0) {
      closeSync(descriptor);
      return false;
    }
  }
  closeSync(descriptor);
  return true;
}

function reviewWorktree(issue, worktree, logPath) {
  const before = commandOutput("git", ["rev-parse", "HEAD"], { cwd: worktree });
  const prompt = `Independently validate the complete diff origin/${defaultBranch()}...HEAD for GitHub issue #${issue.number} and its parent spec. Review it on two separate axes: Standards (repository instructions, glossary, ADRs, documented conventions, and material code smells) and Spec (every acceptance criterion, missing behavior, incorrect behavior, and scope creep). Read the issue and repository evidence yourself. Run additional read-only checks when useful. This is unattended. Do not edit files, commit, push, create or merge a PR, or close issues. Report both axes concisely. End with exactly VALIDATION: PASS only when both axes have zero findings; otherwise end with exactly VALIDATION: FAIL.`;
  const result = commandResult("pi", ["-p", "--no-session", prompt], { cwd: worktree });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  appendAgentLog(logPath, "independent code review", output);
  const after = commandOutput("git", ["rev-parse", "HEAD"], { cwd: worktree });
  const dirty = commandOutput("git", ["status", "--porcelain"], { cwd: worktree });
  if (before !== after || dirty) fail("Independent reviewer modified the branch; refusing to merge");
  return result.status === 0 && validationPassed(output);
}

function issueOpen(number) {
  return commandOutput("gh", ["issue", "view", String(number), "--json", "state", "--jq", ".state"]) === "OPEN";
}

function removeWorktree(worktree, branch) {
  if (existsSync(worktree)) commandResult("git", ["worktree", "remove", "--force", worktree]);
  commandResult("git", ["branch", "-D", branch]);
}

function prepareWorktree(issue, paths, resumeState) {
  if (resumeState?.currentIssue === issue.number && resumeState.worktree && existsSync(resumeState.worktree)) {
    return { worktree: resumeState.worktree, branch: resumeState.branch, resumed: true };
  }
  const branch = `agent/issue-${issue.number}-${Date.now()}`;
  const worktree = join(paths.worktrees, `issue-${issue.number}`);
  if (existsSync(worktree)) fail(`Unrecognized existing worktree: ${worktree}`);
  const base = defaultBranch();
  commandOutput("git", ["fetch", "origin", base]);
  commandOutput("git", ["worktree", "add", "-b", branch, worktree, `origin/${base}`]);
  return { worktree, branch, resumed: false };
}

function remediationPrompt(issue, reasonLog) {
  return `/skill:implement Continue implementing GitHub issue #${issue.number} on the current branch. An independent validation pass failed; inspect ${reasonLog}, the issue, the parent spec, the existing commits, and any uncommitted work. Fix every test or review finding, rerun focused and full validation, use code review, and commit the corrections. Work autonomously. Do not push, create or merge a PR, or close the issue; the tmux orchestrator owns those steps.`;
}

function implementationPrompt(issue, resumed) {
  const action = resumed ? "Continue and finish" : "Implement";
  return `/skill:implement ${action} GitHub issue #${issue.number} (${issue.title}) on the current branch. Read the complete issue, parent spec, repository instructions, glossary, and relevant ADRs. Work autonomously at the agreed public-process test seam. Claiming has already been handled. Run focused checks regularly and the full suite at the end, perform code review, and commit all work with the issue number in the commit message. Do not push, create or merge a PR, or close the issue; the tmux orchestrator owns those steps.`;
}

function waitForPullRequestChecks(prNumber, worktree, logPath) {
  sleep(15_000);
  const initial = commandResult("gh", ["pr", "checks", String(prNumber), "--json", "name,state,bucket"], { cwd: worktree });
  let checks = [];
  try {
    checks = initial.stdout.trim() ? JSON.parse(initial.stdout) : [];
  } catch {
    checks = [];
  }
  if (checks.length === 0) {
    appendAgentLog(logPath, "remote checks", "No remote checks were registered after the grace period; local independent validation remains authoritative.\n");
    return;
  }
  const descriptor = openSync(logPath, "a");
  appendAgentLog(logPath, "remote checks");
  const watched = spawnSync("gh", ["pr", "checks", String(prNumber), "--watch", "--fail-fast"], {
    cwd: worktree,
    env: process.env,
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  if (watched.error || watched.status !== 0) fail(`Remote checks failed for PR #${prNumber}; inspect ${logPath}`);
}

function publishAndMerge(issue, worktree, branch, logPath) {
  const base = defaultBranch();
  commandOutput("git", ["push", "--set-upstream", "origin", branch], { cwd: worktree });
  const existing = commandJson("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"], { cwd: worktree }) ?? [];
  let url;
  let prNumber;
  if (existing.length > 0) {
    ({ number: prNumber, url } = existing[0]);
  } else {
    const body = `Closes #${issue.number}\n\nImplemented and independently validated by the PorcuPi frontier loop.`;
    url = commandOutput("gh", ["pr", "create", "--base", base, "--head", branch, "--title", issue.title, "--body", body], { cwd: worktree });
    prNumber = parsePullRequestNumber(url);
  }
  appendAgentLog(logPath, "pull request", `${url}\n`);
  waitForPullRequestChecks(prNumber, worktree, logPath);
  commandOutput("gh", ["pr", "merge", String(prNumber), "--merge"], { cwd: worktree });
  commandResult("git", ["push", "origin", "--delete", branch], { cwd: worktree });
  for (let attempt = 0; attempt < 15 && issueOpen(issue.number); attempt += 1) sleep(2_000);
  if (issueOpen(issue.number)) {
    commandOutput("gh", ["issue", "close", String(issue.number), "--comment", `Implemented and merged in PR #${prNumber}.`]);
  }
  return prNumber;
}

function processIssue(issue, paths, state) {
  const prepared = prepareWorktree(issue, paths, state);
  const issueLog = join(paths.root, `issue-${issue.number}.log`);
  state = writeState(paths, state, {
    phase: prepared.resumed ? "resuming" : "implementing",
    message: `${prepared.resumed ? "Resuming" : "Implementing"} #${issue.number}: ${issue.title}`,
    currentIssue: issue.number,
    currentIssueTitle: issue.title,
    branch: prepared.branch,
    worktree: prepared.worktree,
    issueLog,
    pullRequest: null,
    lastError: null,
  });
  const login = viewerLogin();
  if (!issue.assignees.some((assignee) => assignee.login === login)) {
    commandOutput("gh", ["issue", "edit", String(issue.number), "--add-assignee", "@me"]);
  }
  log(state.message);
  runAgent(prepared.worktree, implementationPrompt(issue, prepared.resumed), issueLog, prepared.resumed ? "resumed implementation" : "initial implementation");

  for (let attempt = 1; attempt <= maximumAgentAttempts; attempt += 1) {
    state = writeState(paths, state, { phase: "validating", message: `Validating #${issue.number} (attempt ${attempt}/${maximumAgentAttempts})` });
    log(state.message);
    const commitCount = Number(commandOutput("git", ["rev-list", "--count", `origin/${defaultBranch()}..HEAD`], { cwd: prepared.worktree }));
    const clean = commandOutput("git", ["status", "--porcelain"], { cwd: prepared.worktree }) === "";
    const commandsPass = commitCount > 0 && clean && validateWorktree(prepared.worktree, issueLog);
    const reviewPass = commandsPass && reviewWorktree(issue, prepared.worktree, issueLog);
    if (commandsPass && reviewPass) {
      state = writeState(paths, state, { phase: "merging", message: `Publishing and merging #${issue.number}` });
      log(state.message);
      const prNumber = publishAndMerge(issue, prepared.worktree, prepared.branch, issueLog);
      state = writeState(paths, state, { pullRequest: prNumber, message: `Merged #${issue.number} in PR #${prNumber}` });
      log(state.message);
      removeWorktree(prepared.worktree, prepared.branch);
      return writeState(paths, state, {
        phase: "between-tickets",
        currentIssue: null,
        currentIssueTitle: null,
        branch: null,
        worktree: null,
        issueLog: null,
        pullRequest: null,
      });
    }
    if (attempt === maximumAgentAttempts) fail(`Validation failed ${maximumAgentAttempts} times for #${issue.number}; inspect ${issueLog}`);
    state = writeState(paths, state, { phase: "remediating", message: `Remediating validation findings for #${issue.number}` });
    log(state.message);
    runAgent(prepared.worktree, remediationPrompt(issue, issueLog), issueLog, `remediation ${attempt}`);
  }
  return state;
}

function stopped(paths) {
  return existsSync(paths.stop);
}

function runLoop(parent) {
  const paths = loopPaths(parent);
  mkdirSync(paths.worktrees, { recursive: true });
  let state = readState(paths) ?? writeState(paths, {}, {
    schemaVersion: 1,
    parentIssue: parent,
    session: sessionName(parent),
    phase: "starting",
    message: "Starting frontier loop",
    startedAt: isoNow(),
    currentIssue: null,
  });
  try {
    while (!stopped(paths)) {
      let issues = parentIssues(parent);
      const open = issues.filter((issue) => issue.state === "OPEN");
      if (open.length === 0) {
        state = writeState(paths, state, { phase: "complete", message: `All ${issues.length} child tickets are closed`, completedAt: isoNow(), lastError: null });
        log(state.message);
        return;
      }
      let issue;
      if (state.currentIssue && state.worktree && existsSync(state.worktree)) {
        issue = issues.find((candidate) => candidate.number === state.currentIssue && candidate.state === "OPEN");
      }
      issue ??= findFrontier(issues);
      if (!issue) {
        state = writeState(paths, state, { phase: "waiting", message: `${open.length} tickets remain, but no unassigned frontier ticket is available` });
        log(`${state.message}; polling again in ${defaultPollSeconds}s`);
        sleep(defaultPollSeconds * 1_000);
        continue;
      }
      state = processIssue(issue, paths, state);
    }
    state = writeState(paths, state, { phase: "stopped", message: "Stopped by request" });
    log(state.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const phase = stopped(paths) ? "stopped" : "failed";
    state = failureBaseState(state, readState(paths));
    state = writeState(paths, state, { phase, message: phase === "stopped" ? "Stopped by request" : "Frontier loop stopped on failure", lastError: message });
    log(`${state.message}: ${message}`);
    process.exitCode = phase === "failed" ? 1 : 0;
  }
}

function tail(path, count) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trimEnd().split("\n").slice(-count);
}

function status(parent) {
  const paths = loopPaths(parent);
  const state = readState(paths);
  const alive = tmuxAlive(parent);
  process.stdout.write(`Frontier loop: ${alive ? "running" : "not running"}\n`);
  process.stdout.write(`Session:       ${sessionName(parent)}\n`);
  process.stdout.write(`Parent:        #${parent}\n`);
  if (state) {
    process.stdout.write(`Phase:         ${state.phase}\n`);
    process.stdout.write(`Message:       ${state.message ?? "-"}\n`);
    if (state.currentIssue) process.stdout.write(`Current:       #${state.currentIssue} ${state.currentIssueTitle ?? ""}\n`);
    let pullRequest = state.pullRequest;
    if (!pullRequest && state.branch) {
      try {
        const open = commandJson("gh", ["pr", "list", "--head", state.branch, "--state", "open", "--json", "number"]) ?? [];
        pullRequest = open[0]?.number;
      } catch {
        // The rest of status remains useful when PR lookup is unavailable.
      }
    }
    if (pullRequest) process.stdout.write(`Pull request:  #${pullRequest}\n`);
    if (state.worktree) process.stdout.write(`Worktree:      ${state.worktree}\n`);
    if (state.issueLog) process.stdout.write(`Issue log:     ${state.issueLog}\n`);
    if (state.lastError) process.stdout.write(`Last error:    ${state.lastError}\n`);
    process.stdout.write(`Updated:       ${state.updatedAt}\n`);
  } else {
    process.stdout.write("Phase:         never started\n");
  }
  try {
    const issues = parentIssues(parent);
    const closed = issues.filter((issue) => issue.state === "CLOSED").length;
    const frontier = findFrontier(issues);
    process.stdout.write(`Progress:      ${closed}/${issues.length} tickets closed\n`);
    process.stdout.write(`Live frontier: ${frontier ? `#${frontier.number} ${frontier.title}` : "none"}\n`);
  } catch (error) {
    process.stdout.write(`GitHub status: unavailable (${error instanceof Error ? error.message : String(error)})\n`);
  }
  const lines = state?.issueLog ? tail(state.issueLog, 12) : tail(paths.runnerLog, 12);
  if (lines.length > 0) process.stdout.write(`\nRecent log:\n${lines.join("\n")}\n`);
}

function attach(parent) {
  if (!tmuxAlive(parent)) fail(`tmux session ${sessionName(parent)} is not running`);
  const result = spawnSync("tmux", ["attach-session", "-t", sessionName(parent)], { stdio: "inherit" });
  if (result.error || result.status !== 0) process.exitCode = result.status ?? 1;
}

function stop(parent) {
  const paths = loopPaths(parent);
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.stop, `${isoNow()}\n`);
  if (!tmuxAlive(parent)) {
    if (tmuxSessionExists(parent)) commandResult("tmux", ["kill-session", "-t", sessionName(parent)]);
    process.stdout.write("Frontier loop is not running. Stop marker recorded.\n");
    return;
  }
  commandResult("tmux", ["send-keys", "-t", sessionName(parent), "C-c"]);
  sleep(2_000);
  if (tmuxSessionExists(parent)) commandResult("tmux", ["kill-session", "-t", sessionName(parent)]);
  process.stdout.write("Frontier loop stopped.\n");
}

function parseArguments(argv) {
  const command = argv[0];
  let parent = Number(process.env.PORCUPI_FRONTIER_PARENT ?? defaultParent);
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--parent") {
      parent = Number(argv[index + 1]);
      index += 1;
    } else fail(`Unknown argument: ${argv[index]}`);
  }
  if (!Number.isSafeInteger(parent) || parent <= 0) fail("Parent issue must be a positive integer");
  return { command, parent };
}

function usage() {
  process.stdout.write("Usage: node scripts/frontier-loop.mjs start|run|status|attach|stop [--parent ISSUE]\n");
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const { command, parent } = parseArguments(process.argv.slice(2));
    if (command === "start") start(parent);
    else if (command === "run") runLoop(parent);
    else if (command === "status") status(parent);
    else if (command === "attach") attach(parent);
    else if (command === "stop") stop(parent);
    else {
      usage();
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`frontier-loop: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
