#!/usr/bin/env node
// PROTOTYPE: throwaway TUI for PorcuPi issue #9. No real system operations occur.

import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  PI_BASE,
  PI_BASE_COMMIT,
  applyPatches,
  artifactKey,
  initialState,
  install,
  launch,
  manageSelections,
  patchOrder,
  rollback,
  setNextApply,
  setPiOwnership,
  setRequiredExecutable,
  setSourceSelections,
  uninstall,
  verify,
} from "./model.mjs";

const bold = (text) => `\x1b[1m${text}\x1b[0m`;
const dim = (text) => `\x1b[2m${text}\x1b[0m`;

const MATT_SKILL_PATHS = `
skills/deprecated/design-an-interface/SKILL.md
skills/deprecated/qa/SKILL.md
skills/deprecated/request-refactor-plan/SKILL.md
skills/deprecated/ubiquitous-language/SKILL.md
skills/engineering/ask-matt/SKILL.md
skills/engineering/code-review/SKILL.md
skills/engineering/codebase-design/SKILL.md
skills/engineering/diagnosing-bugs/SKILL.md
skills/engineering/domain-modeling/SKILL.md
skills/engineering/grill-with-docs/SKILL.md
skills/engineering/implement/SKILL.md
skills/engineering/improve-codebase-architecture/SKILL.md
skills/engineering/prototype/SKILL.md
skills/engineering/research/SKILL.md
skills/engineering/resolving-merge-conflicts/SKILL.md
skills/engineering/setup-matt-pocock-skills/SKILL.md
skills/engineering/tdd/SKILL.md
skills/engineering/to-spec/SKILL.md
skills/engineering/to-tickets/SKILL.md
skills/engineering/triage/SKILL.md
skills/engineering/wayfinder/SKILL.md
skills/in-progress/batch-grill-me/SKILL.md
skills/in-progress/claude-handoff/SKILL.md
skills/in-progress/loop-me/SKILL.md
skills/in-progress/setup-ts-deep-modules/SKILL.md
skills/in-progress/to-questionnaire/SKILL.md
skills/in-progress/wizard/SKILL.md
skills/in-progress/writing-beats/SKILL.md
skills/in-progress/writing-fragments/SKILL.md
skills/in-progress/writing-shape/SKILL.md
skills/misc/git-guardrails-claude-code/SKILL.md
skills/misc/migrate-to-shoehorn/SKILL.md
skills/misc/scaffold-exercises/SKILL.md
skills/misc/setup-pre-commit/SKILL.md
skills/personal/edit-article/SKILL.md
skills/personal/obsidian-vault/SKILL.md
skills/productivity/grill-me/SKILL.md
skills/productivity/grilling/SKILL.md
skills/productivity/handoff/SKILL.md
skills/productivity/teach/SKILL.md
skills/productivity/writing-great-skills/SKILL.md
`
  .trim()
  .split("\n");

const WAIT_PATCHES = [
  { path: "patches/active/0001-feat-add-durable-single-tool-deferral.patch", sha256: "00490f0b4ab701ede5f2db621040b49d87c780db53e943afe02b6bb79c8a4621" },
  { path: "patches/active/0002-feat-respond-and-resume-deferred-tool-call.patch", sha256: "9cdee449e8c84e153d7236b71bc0d24bf077f55b34d90d290ddae2c6e846b5ef" },
  { path: "patches/active/0003-feat-hold-and-resume-tool-batches-atomically.patch", sha256: "6d63bd9a48d611645cd2e60afbbe926b09c70d7460ab8052c81ce5184c419765" },
  { path: "patches/active/0004-feat-interrupt-waiting-state-with-user-input.patch", sha256: "daf577cbde71675d5c9962a007d1c83f28d59d0b1bb9bdeb9a93bd25c8d65b48" },
  { path: "patches/active/0005-feat-recover-deferred-batches-idempotently.patch", sha256: "63770e31fe26d8a4b7be7c7f17b112b8dcb0d0acdd35af26573ed3f642e2e695" },
  { path: "patches/active/0006-feat-preserve-deferred-lifecycle-through-branches.patch", sha256: "3da4a7058635a7bea3baa490dba4c0ca7b1b850ee61e8f6e7aca698d4f760a30" },
  { path: "patches/active/0007-feat-restore-or-abandon-unavailable-deferred-batches.patch", sha256: "3e4f238a3ff4c7586332c50bfb8d44d0640520fd5b16d52ae1a24fbb299f3686" },
  { path: "patches/active/0008-feat-expose-deferred-work-in-headless-modes.patch", sha256: "9bc4d4c08b53eaaf2329946bd9f9e9608d78ea2acb73a312ea5f7df2772ccacb" },
  { path: "patches/active/0009-feat-expose-deferred-work-to-extensions-and-tui.patch", sha256: "6c78cdab8680d89de49161f2de143e91c5aa73d9c44181ef35bbebe79badf1f4" },
  { path: "patches/active/0010-feat-add-deferred-extension-conformance.patch", sha256: "12b21426d39711296c3ca9976c9319401ba9cec1791b32a22fa56122181f5d10" },
  { path: "patches/active/0011-fix-fail-closed-on-live-unavailable-resolver.patch", sha256: "0ce85715f091a4b1682bc4c63c0f703fc3afaecf81977666968922c085185544" },
  { path: "patches/active/0012-fix-reconstruct-example-presenter.patch", sha256: "9de0402b24f6d3ece12a163963cce9d3c19f70837771a19891fd051f1424ede7" },
  { path: "patches/active/0013-doc-eager-downstream-session-header.patch", sha256: "b697ac01332d2c2c7120a9c4a4b6b332fee6f821120f8b7c716b4b12df314d36" },
  { path: "patches/active/0014-feat-add-core-deferred-reentry-affordance.patch", sha256: "8f2e6ba41845bf0b07ffe67a74caac6e0790c9f56e993194dab180d74c802c26" },
  { path: "patches/active/0015-fix-remove-retired-nvidia-model.patch", sha256: "0dd1fa4d619fb5b7297d19e8b0c980a7f13634a2098cb7249861a6800c61bfb7" },
  { path: "patches/active/0016-fix-remove-retired-openai-models.patch", sha256: "aa0596a76ca1e1767f6d7326619f6503b68f9a319a78d26500737264dfeb5ed0" },
  { path: "patches/active/0017-build-only-supported-release-platforms.patch", sha256: "55ec2cff8f59e64427f6b40615fcf818f17aefbfadf7cdf4861e7e306482af30" },
  { path: "patches/active/0018-fix-remove-withdrawn-vercel-models.patch", sha256: "844f2b89000d1afe3407239323ea34dad58d7cc8e1074b20dc0a646e69469644" },
  { path: "patches/active/0019-fix-keep-model-config-refresh-offline.patch", sha256: "0118753a15a42f537c8c3edfa69098e83166a3b1a00a5312d4e02d5d786f7895" },
  { path: "patches/active/0020-fix-remove-newly-withdrawn-models.patch", sha256: "592936974154278037c51042a94d70e3dccafd9988cb21d3b85b837050769cd7" },
];

const WAIT_SOURCE = {
  locator: "https://github.com/taylorrowser/pi-wait-for-user.git",
  commit: "1a987bca79a4f9475dd2037c18b2d6d7b7f68f25",
  artifacts: WAIT_PATCHES.map((patch) => ({ kind: "Patch", ...patch })),
};

const SOURCES = {
  core: WAIT_SOURCE,
  wait: WAIT_SOURCE,
  extras: {
    locator: "https://codeberg.org/example/pi-extras.git",
    commit: "2222222222222222222222222222222222222222",
    artifacts: [
      { kind: "Theme", path: "themes/piglet.json" },
      {
        kind: "Patch",
        path: "patches/compact-footer.patch",
        sha256: "b".repeat(64),
        name: "Compact footer",
        description: "Reduces the interactive footer to one status line.",
        supportedPiBases: [PI_BASE_COMMIT],
      },
      {
        kind: "Patch",
        path: "patches/future-only.patch",
        sha256: "c".repeat(64),
        name: "Future-only example",
        description: "Demonstrates declared Pi Base compatibility.",
        supportedPiBases: ["3333333333333333333333333333333333333333"],
      },
    ],
  },
  matt: {
    locator: "https://github.com/mattpocock/skills.git",
    commit: "2ab958093e83e0ec752e6c1c5932da465bf23e0c",
    artifacts: MATT_SKILL_PATHS.map((path) => ({ kind: "Skill", path })),
  },
};

function normalizeSource(value) {
  return value.trim().replace(/\/$/, "").replace(/\.git$/i, "").toLowerCase();
}

function findSource(value) {
  if (SOURCES[value]) return SOURCES[value];
  const normalized = normalizeSource(value);
  return Object.values(SOURCES).find((source) => normalizeSource(source.locator) === normalized);
}

function supportsCurrentPiBase(artifact) {
  return !artifact.supportedPiBases || artifact.supportedPiBases.includes(PI_BASE_COMMIT);
}

let rl = createInterface({ input, output });
let state = initialState();

function compositionLine(composition) {
  if (!composition) return "none";
  const suffix = composition.patches.length ? ` — ${composition.patches.join(", ")}` : " — unpatched Pi Base";
  return `${composition.id}${suffix}`;
}

function render() {
  console.clear();
  console.log(bold("PROTOTYPE — PorcuPi v1 command surface"));
  console.log(dim("In-memory only. No Git, Pi, build, launcher, or filesystem changes occur."));
  console.log();
  console.log(bold("Current state"));
  console.log(`${bold("Installed:")} ${state.installed ? "yes" : "no"}`);
  console.log(`${bold("pi command:")} ${state.piEntrypoint}`);
  console.log(`${bold("Pi Base:")} ${PI_BASE}`);
  console.log(`${bold("Active:")} ${compositionLine(state.active)}`);
  console.log(`${bold("Previous:")} ${compositionLine(state.previous)}`);
  console.log(`${bold("Executable:")} ${state.requiredExecutable}`);
  console.log(`${bold("Next apply:")} ${state.nextApply}`);
  console.log();
  console.log(bold("Current Pi resources (managed by Pi; retained after PorcuPi uninstall)"));
  if (state.packageSelections.length === 0) console.log(dim("  none"));
  for (const item of state.packageSelections.slice(0, 5)) {
    console.log(`  ${item.kind.padEnd(9)} ${item.path}  ${dim(`[${item.scope}, ${item.commit.slice(0, 8)}]`)}`);
  }
  if (state.packageSelections.length > 5) {
    console.log(dim(`  … ${state.packageSelections.length - 5} more; use \`porcupi manage\``));
  }
  console.log();
  console.log(bold("Selected Patches (run `porcupi apply` to update Managed Pi)"));
  if (state.patchSelections.length === 0) console.log(dim("  none"));
  patchOrder(state.patchSelections)
    .slice(0, 5)
    .forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.path}  ${dim(`[${item.commit.slice(0, 8)}, sha256:${item.sha256.slice(0, 8)}]`)}`);
    });
  if (state.patchSelections.length > 5) {
    console.log(dim(`  … ${state.patchSelections.length - 5} more; use \`porcupi manage\``));
  }
  console.log();
  console.log(`${bold("Last result:")} ${state.lastResult}`);
  console.log();
  console.log(bold("Actions"));
  console.log("[i] bootstrap install       [a] porcupi add [source]      [m] porcupi manage");
  console.log("[p] porcupi apply          [l] porcupi (launch)          [v] porcupi verify");
  console.log("[r] porcupi rollback");
  console.log("[o] porcupi pi enable/disable   [f] toggle apply failure  [c] toggle corruption");
  console.log("[u] porcupi uninstall      [q] quit");
  console.log(dim("Type either a shortcut key or the displayed full command."));
}

async function runChoiceScreen({ title, lines, options, initialIndex = 0 }) {
  rl.close();
  let cursor = initialIndex;
  const result = await new Promise((resolve) => {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    const renderChoice = () => {
      console.clear();
      console.log(bold(title));
      lines.forEach((line) => console.log(line));
      console.log();
      options.forEach((option, index) => {
        const row = `${index === cursor ? "›" : " "} ${option.label}`;
        console.log(index === cursor ? bold(row) : row);
      });
      console.log();
      console.log("[↑/↓ j/k] move  [Space/Enter] choose  [Esc] cancel");
    };
    const finish = (value) => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      resolve(value);
    };
    const onKeypress = (_character, key) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish(null);
        return;
      }
      if (key.name === "up" || key.name === "k") cursor = Math.max(0, cursor - 1);
      else if (key.name === "down" || key.name === "j") cursor = Math.min(options.length - 1, cursor + 1);
      else if (key.name === "space" || key.name === "return") {
        finish(options[cursor].value);
        return;
      }
      renderChoice();
    };
    input.on("keypress", onKeypress);
    renderChoice();
  });
  rl = createInterface({ input, output });
  return result;
}

async function runInstall() {
  if (state.installed) {
    state = install(state, { claimPi: false });
    return;
  }
  const claimPi = await runChoiceScreen({
    title: "Install PorcuPi",
    lines: ["The installer always publishes `porcupi`.", "Choose who should own the separate `pi` command:"],
    options: [
      { label: "Keep Stock Pi as `pi` (recommended)", value: false },
      { label: "Let PorcuPi own `pi`; keep Stock Pi independently installed", value: true },
    ],
  });
  if (claimPi === null) {
    state = { ...state, lastResult: "Installation cancelled; nothing changed." };
    return;
  }
  state = install(state, { claimPi });
}

async function runSelectionWizard({ source, artifacts, current, initialScope }) {
  rl.close();
  const selected = new Set(current);
  const scopes = ["global", "project"];
  let page = 0;
  let artifactCursor = 0;
  let scopeCursor = Math.max(0, scopes.indexOf(initialScope));
  let scope = scopes[scopeCursor];
  let reviewCursor = 0;

  const result = await new Promise((resolve) => {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const truncate = (value, reservedWidth = 18) => {
      const width = Math.max(16, (output.columns || 100) - reservedWidth);
      return value.length > width ? `${value.slice(0, width - 1)}…` : value;
    };

    const windowAround = (cursor, count, reservedRows) => {
      const availableRows = Math.max(4, (output.rows || 24) - reservedRows);
      const start = Math.max(0, Math.min(cursor - Math.floor(availableRows / 2), count - availableRows));
      return { start, end: Math.min(count, start + availableRows) };
    };

    const renderArtifacts = () => {
      const { start, end } = windowAround(artifactCursor, artifacts.length, 13);
      console.log(bold("1 of 3 — Select Artifacts"));
      console.log(`${bold("Repository:")} ${source.locator}`);
      console.log(`${bold("Fixed version (commit):")} ${source.commit}`);
      console.log(dim(`${selected.size} selected; ${artifacts.length} available`));
      console.log(dim(`Use ↑/↓ or j/k to scroll: ${start} above · ${Math.max(0, artifacts.length - end)} below`));
      console.log();
      for (let index = start; index < end; index += 1) {
        const artifact = artifacts[index];
        const pointer = index === artifactCursor ? "›" : " ";
        const mark = selected.has(artifact.path) ? "x" : " ";
        const compatible = supportsCurrentPiBase(artifact);
        const label = artifact.name ? `${artifact.name} — ${artifact.path}` : artifact.path;
        const suffix = compatible ? "" : "  [not supported by this Pi Base]";
        const row = `${pointer} [${mark}] ${artifact.kind.padEnd(9)} ${truncate(`${label}${suffix}`)}`;
        console.log(index === artifactCursor ? bold(row) : row);
      }
      const focused = artifacts[artifactCursor];
      const compatibility = focused.supportedPiBases
        ? supportsCurrentPiBase(focused)
          ? "supports this Pi Base"
          : "does not support this Pi Base"
        : "no compatibility metadata; the build remains authoritative";
      console.log(dim(`Details: ${truncate(`${focused.description ?? focused.path} — ${compatibility}`, 9)}`));
      console.log();
      console.log("[↑/↓ j/k] move  [Space/Enter] toggle  [a] select all  [d] deselect all");
      console.log(`${bold("[n → l] Next")}  [Esc] cancel`);
    };

    const renderScope = () => {
      const resourceCount = artifacts.filter(
        (artifact) => artifact.kind !== "Patch" && selected.has(artifact.path),
      ).length;
      const patchCount = artifacts.filter(
        (artifact) => artifact.kind === "Patch" && selected.has(artifact.path),
      ).length;
      console.log(bold("2 of 3 — Choose resource scope"));
      console.log(`${bold("Selected:")} ${resourceCount} Pi resource(s), ${patchCount} Patch(es)`);
      console.log("Scope applies only to Skills, Extensions, Prompts, and Themes. Patches only affect Managed Pi.");
      console.log();
      scopes.forEach((option, index) => {
        const pointer = index === scopeCursor ? "›" : " ";
        const mark = option === scope ? "x" : " ";
        const description =
          option === "global"
            ? "available to your user across projects"
            : "available only in this project, subject to Pi project trust";
        const row = `${pointer} (${mark}) ${option.padEnd(7)} — ${description}`;
        console.log(index === scopeCursor ? bold(row) : row);
      });
      if (resourceCount === 0) console.log(dim("No Pi resources are selected, so this choice will not be saved."));
      console.log();
      console.log("[↑/↓ j/k] move  [Space/Enter] choose");
      console.log(`${bold("[n → l] Next")}  [← h] Back  [Esc] cancel`);
    };

    const renderConfirmation = () => {
      const chosen = artifacts.filter((artifact) => selected.has(artifact.path));
      const resourceCount = chosen.filter((artifact) => artifact.kind !== "Patch").length;
      const patchCount = chosen.length - resourceCount;
      reviewCursor = Math.min(reviewCursor, Math.max(0, chosen.length - 1));
      const { start, end } = windowAround(reviewCursor, Math.max(1, chosen.length), 15);
      console.log(bold("3 of 3 — Review and save"));
      console.log(`${bold("Repository:")} ${source.locator}`);
      console.log(`${bold("Fixed version:")} ${source.commit.slice(0, 12)} — unchanged until you select another version`);
      const resourceSummary = resourceCount > 0 ? `${resourceCount} Pi resource(s) (${scope})` : "0 Pi resources";
      console.log(`${bold("Selections:")} ${resourceSummary}, ${patchCount} Patch(es)`);
      console.log(dim("Selected content can affect Pi with your user permissions. PorcuPi does not sandbox it."));
      console.log();
      if (chosen.length === 0) {
        console.log("  No Artifacts selected. Saving removes this repository's existing selections.");
      } else {
        for (let index = start; index < end; index += 1) {
          const artifact = chosen[index];
          const pointer = index === reviewCursor ? "›" : " ";
          const row = `${pointer} ${artifact.kind.padEnd(9)} ${truncate(artifact.path, 16)}`;
          console.log(index === reviewCursor ? bold(row) : row);
        }
        console.log(dim(`Review list: ${start} above · ${Math.max(0, chosen.length - end)} below`));
      }
      console.log();
      console.log("[↑/↓ j/k] review  [← h] Back  [Esc] cancel");
      console.log(bold("[Space/Enter] Save selections"));
    };

    const renderWizard = () => {
      console.clear();
      if (page === 0) renderArtifacts();
      else if (page === 1) renderScope();
      else renderConfirmation();
    };

    const finish = (value) => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      resolve(value);
    };

    const moveBack = () => {
      page = Math.max(0, page - 1);
    };
    const moveNext = () => {
      page = Math.min(2, page + 1);
    };

    const onKeypress = (_character, key) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish(null);
        return;
      }
      if (key.name === "left" || key.name === "h") moveBack();
      else if (key.name === "right" || key.name === "l" || key.name === "n") moveNext();
      else if (key.name === "up" || key.name === "k") {
        if (page === 0) artifactCursor = Math.max(0, artifactCursor - 1);
        else if (page === 1) scopeCursor = Math.max(0, scopeCursor - 1);
        else reviewCursor = Math.max(0, reviewCursor - 1);
      } else if (key.name === "down" || key.name === "j") {
        if (page === 0) artifactCursor = Math.min(artifacts.length - 1, artifactCursor + 1);
        else if (page === 1) scopeCursor = Math.min(scopes.length - 1, scopeCursor + 1);
        else reviewCursor = Math.min(Math.max(0, selected.size - 1), reviewCursor + 1);
      } else if (key.name === "space" || key.name === "return") {
        if (page === 0) {
          const artifact = artifacts[artifactCursor];
          const path = artifact.path;
          if (selected.has(path)) selected.delete(path);
          else if (supportsCurrentPiBase(artifact)) selected.add(path);
        } else if (page === 1) {
          scope = scopes[scopeCursor];
        } else {
          finish({ selectedPaths: [...selected], scope });
          return;
        }
      } else if (page === 0 && key.name === "a") {
        artifacts.filter(supportsCurrentPiBase).forEach((artifact) => selected.add(artifact.path));
      } else if (page === 0 && key.name === "d") {
        selected.clear();
      }
      renderWizard();
    };

    input.on("keypress", onKeypress);
    renderWizard();
  });

  rl = createInterface({ input, output });
  return result;
}

async function runManagementWizard(items) {
  rl.close();
  const kept = new Set(items.map(artifactKey));
  const resourceScopes = Object.fromEntries(
    items.filter((item) => item.kind !== "Patch").map((item) => [artifactKey(item), item.scope]),
  );
  const resources = () => items.filter((item) => item.kind !== "Patch" && kept.has(artifactKey(item)));
  let page = 0;
  let itemCursor = 0;
  let scopeCursor = 0;
  let reviewCursor = 0;

  const result = await new Promise((resolve) => {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const truncate = (value, reservedWidth = 12) => {
      const width = Math.max(16, (output.columns || 100) - reservedWidth);
      return value.length > width ? `${value.slice(0, width - 1)}…` : value;
    };
    const windowAround = (cursor, count, reservedRows) => {
      const availableRows = Math.max(4, (output.rows || 24) - reservedRows);
      const start = Math.max(0, Math.min(cursor - Math.floor(availableRows / 2), count - availableRows));
      return { start, end: Math.min(count, start + availableRows) };
    };
    const sourceLabel = (source) => source.replace(/^https?:\/\//, "").replace(/\.git$/, "");

    const renderCurrent = () => {
      const { start, end } = windowAround(itemCursor, items.length, 10);
      console.log(bold("1 of 3 — Keep or remove current selections"));
      console.log(dim(`${kept.size} kept; ${items.length - kept.size} marked for removal`));
      console.log();
      for (let index = start; index < end; index += 1) {
        const item = items[index];
        const pointer = index === itemCursor ? "›" : " ";
        const mark = kept.has(artifactKey(item)) ? "x" : " ";
        const row = `${pointer} [${mark}] ${item.kind.padEnd(9)} ${sourceLabel(item.source)} :: ${item.path}`;
        console.log(index === itemCursor ? bold(truncate(row, 0)) : truncate(row, 0));
      }
      console.log(dim(`Use ↑/↓ or j/k to scroll: ${start} above · ${Math.max(0, items.length - end)} below`));
      console.log();
      console.log("[↑/↓ j/k] move  [Space/Enter] keep/remove  [a] keep all  [d] remove all");
      console.log(`${bold("[n → l] Next")}  [Esc] cancel`);
    };

    const renderScopes = () => {
      const scoped = resources();
      scopeCursor = Math.min(scopeCursor, Math.max(0, scoped.length - 1));
      const { start, end } = windowAround(scopeCursor, Math.max(1, scoped.length), 11);
      console.log(bold("2 of 3 — Review resource scopes"));
      console.log("Space or Enter toggles each retained resource between global and project scope.");
      console.log(dim("Patches do not have a scope and are not listed on this page."));
      console.log();
      if (scoped.length === 0) {
        console.log("  No retained Pi resources.");
      } else {
        for (let index = start; index < end; index += 1) {
          const item = scoped[index];
          const pointer = index === scopeCursor ? "›" : " ";
          const row = `${pointer} [${resourceScopes[artifactKey(item)]}] ${item.kind.padEnd(9)} ${item.path}`;
          console.log(index === scopeCursor ? bold(truncate(row, 0)) : truncate(row, 0));
        }
      }
      console.log();
      console.log("[↑/↓ j/k] move  [Space/Enter] toggle scope");
      console.log(`${bold("[n → l] Next")}  [← h] Back  [Esc] cancel`);
    };

    const changes = () => {
      const removed = items.filter((item) => !kept.has(artifactKey(item)));
      const changedScopes = items.filter(
        (item) => item.kind !== "Patch" && kept.has(artifactKey(item)) && resourceScopes[artifactKey(item)] !== item.scope,
      );
      return [
        ...removed.map((item) => `Remove ${item.kind}: ${item.path}`),
        ...changedScopes.map((item) => `Move ${item.kind} to ${resourceScopes[artifactKey(item)]}: ${item.path}`),
      ];
    };

    const renderConfirmation = () => {
      const pending = changes();
      reviewCursor = Math.min(reviewCursor, Math.max(0, pending.length - 1));
      const { start, end } = windowAround(reviewCursor, Math.max(1, pending.length), 11);
      const removesPatch = items.some((item) => item.kind === "Patch" && !kept.has(artifactKey(item)));
      console.log(bold("3 of 3 — Review and save"));
      console.log(`${bold("Result:")} keep ${kept.size}, remove ${items.length - kept.size}`);
      console.log("Pi resource changes take effect through Pi. Patch changes remain pending until `porcupi apply`.");
      if (removesPatch) console.log(dim("The active Managed Pi does not change when these selections are saved."));
      console.log();
      if (pending.length === 0) console.log("  No changes.");
      else {
        for (let index = start; index < end; index += 1) {
          const pointer = index === reviewCursor ? "›" : " ";
          console.log(index === reviewCursor ? bold(truncate(`${pointer} ${pending[index]}`, 0)) : truncate(`  ${pending[index]}`, 0));
        }
      }
      console.log();
      console.log("[↑/↓ j/k] review  [← h] Back  [Esc] cancel");
      console.log(bold("[Space/Enter] Save changes"));
    };

    const renderWizard = () => {
      console.clear();
      if (page === 0) renderCurrent();
      else if (page === 1) renderScopes();
      else renderConfirmation();
    };
    const finish = (value) => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      resolve(value);
    };
    const onKeypress = (_character, key) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        finish(null);
        return;
      }
      if (key.name === "left" || key.name === "h") page = Math.max(0, page - 1);
      else if (key.name === "right" || key.name === "l" || key.name === "n") page = Math.min(2, page + 1);
      else if (key.name === "up" || key.name === "k") {
        if (page === 0) itemCursor = Math.max(0, itemCursor - 1);
        else if (page === 1) scopeCursor = Math.max(0, scopeCursor - 1);
        else reviewCursor = Math.max(0, reviewCursor - 1);
      } else if (key.name === "down" || key.name === "j") {
        if (page === 0) itemCursor = Math.min(items.length - 1, itemCursor + 1);
        else if (page === 1) scopeCursor = Math.min(Math.max(0, resources().length - 1), scopeCursor + 1);
        else reviewCursor = Math.min(Math.max(0, changes().length - 1), reviewCursor + 1);
      } else if (key.name === "space" || key.name === "return") {
        if (page === 0) {
          const keyValue = artifactKey(items[itemCursor]);
          if (kept.has(keyValue)) kept.delete(keyValue);
          else kept.add(keyValue);
        } else if (page === 1) {
          const item = resources()[scopeCursor];
          if (item) {
            const keyValue = artifactKey(item);
            resourceScopes[keyValue] = resourceScopes[keyValue] === "global" ? "project" : "global";
          }
        } else {
          finish({ keptKeys: [...kept], resourceScopes });
          return;
        }
      } else if (page === 0 && key.name === "a") {
        items.forEach((item) => kept.add(artifactKey(item)));
      } else if (page === 0 && key.name === "d") {
        kept.clear();
      }
      renderWizard();
    };

    input.on("keypress", onKeypress);
    renderWizard();
  });

  rl = createInterface({ input, output });
  return result;
}

async function runManage() {
  const items = [...state.packageSelections, ...state.patchSelections].sort((left, right) =>
    `${left.source}\0${left.kind}\0${left.path}`.localeCompare(`${right.source}\0${right.kind}\0${right.path}`),
  );
  if (items.length === 0) {
    state = { ...state, lastResult: "There are no current selections to manage. Add a Git source first." };
    return;
  }
  const result = await runManagementWizard(items);
  if (result === null) {
    state = { ...state, lastResult: "Management cancelled; saved selections and activation are unchanged." };
    return;
  }
  state = manageSelections(state, result);
}

async function runAdd(requestedSource = "") {
  console.log();
  console.log(`${bold("Fixture Source Repositories:")} wait, extras, matt`);
  const sourceInput = requestedSource || (await rl.question("Git source [wait]: ")).trim() || "wait";
  const source = findSource(sourceInput);
  if (!source) {
    state = {
      ...state,
      lastResult: `Add cancelled: this in-memory prototype has no fixture for '${sourceInput}'.`,
    };
    return;
  }

  const current = new Set([
    ...state.packageSelections.filter((item) => item.source === source.locator).map((item) => item.path),
    ...state.patchSelections.filter((item) => item.source === source.locator).map((item) => item.path),
  ]);
  const existingScopes = new Set(
    state.packageSelections.filter((item) => item.source === source.locator).map((item) => item.scope),
  );
  const initialScope = existingScopes.size === 1 ? [...existingScopes][0] : "global";
  const result = await runSelectionWizard({
    source,
    artifacts: source.artifacts,
    current,
    initialScope,
  });
  if (result === null) {
    state = { ...state, lastResult: "Selection cancelled; saved selections and activation are unchanged." };
    return;
  }
  const { selectedPaths, scope } = result;
  const selectedResources = source.artifacts.filter(
    (candidate) => candidate.kind !== "Patch" && selectedPaths.includes(candidate.path),
  );
  const scopes = Object.fromEntries(selectedResources.map((artifact) => [artifact.path, scope]));
  state = setSourceSelections(state, {
    source: source.locator,
    commit: source.commit,
    artifacts: source.artifacts,
    selectedPaths,
    scopes,
  });
}

async function runApply() {
  if (!state.installed) {
    state = applyPatches(state);
    return;
  }
  const ordered = patchOrder(state.patchSelections);
  const preview = ordered.length
    ? ordered.slice(0, 8).map((patch, index) => `${index + 1}. ${patch.path}`)
    : ["No Patches selected; candidate is the exact Pi Base."];
  if (ordered.length > 8) preview.push(`… ${ordered.length - 8} more Patches`);
  preview.push(`Simulated build outcome: ${state.nextApply}.`);
  const confirmed = await runChoiceScreen({
    title: "Apply Patch selections",
    lines: preview,
    options: [
      { label: "Build, verify, and activate this Managed Pi", value: true },
      { label: "Cancel; keep the current Managed Pi", value: false },
    ],
    initialIndex: 1,
  });
  if (!confirmed) {
    state = { ...state, lastResult: "Apply cancelled; activation is unchanged." };
    return;
  }
  state = applyPatches(state);
}

async function runRollback() {
  if (!state.installed || !state.previous) {
    state = rollback(state);
    return;
  }
  const confirmed = await runChoiceScreen({
    title: "Roll back Managed Pi",
    lines: [
      `Current:  ${compositionLine(state.active)}`,
      `Previous: ${compositionLine(state.previous)}`,
      "Patch selections will not change.",
    ],
    options: [
      { label: "Verify and activate the previous composition", value: true },
      { label: "Cancel; keep the current composition", value: false },
    ],
    initialIndex: 1,
  });
  if (!confirmed) {
    state = { ...state, lastResult: "Rollback cancelled; activation is unchanged." };
    return;
  }
  state = rollback(state);
}

async function runPiOwnership() {
  const managed = state.piEntrypoint.startsWith("Managed Pi");
  state = setPiOwnership(state, !managed);
}

async function runUninstall() {
  if (!state.installed) {
    state = uninstall(state);
    return;
  }
  const confirmed = await runChoiceScreen({
    title: "Uninstall PorcuPi",
    lines: [
      "Remove PorcuPi-owned launchers, Patch selections, receipts, and Managed Pi payloads.",
      `Leave ${state.packageSelections.length} Pi resource selection(s) in Pi package settings.`,
      "Stock Pi remains independently installed.",
    ],
    options: [
      { label: "Uninstall PorcuPi-owned state", value: true },
      { label: "Cancel; change nothing", value: false },
    ],
    initialIndex: 1,
  });
  if (confirmed) state = uninstall(state);
  else state = { ...state, lastResult: "Uninstall cancelled; nothing changed." };
}

try {
  while (true) {
    render();
    const rawAction = (await rl.question("> ")).trim();
    const action = rawAction.toLowerCase();
    if (action === "q" || action === "quit" || action === "exit") break;
    if (action === "i" || action === "install") await runInstall();
    else if (action === "a" || action === "porcupi add") await runAdd();
    else if (action.startsWith("porcupi add ")) await runAdd(rawAction.slice("porcupi add ".length).trim());
    else if (action === "m" || action === "porcupi manage") await runManage();
    else if (action === "p" || action === "porcupi apply") await runApply();
    else if (action === "l" || action === "porcupi") state = launch(state);
    else if (action === "v" || action === "porcupi verify") state = verify(state);
    else if (action === "r" || action === "porcupi rollback") await runRollback();
    else if (action === "o") await runPiOwnership();
    else if (action === "porcupi pi enable") state = setPiOwnership(state, true);
    else if (action === "porcupi pi disable") state = setPiOwnership(state, false);
    else if (action === "f") state = setNextApply(state, state.nextApply === "success" ? "fail" : "success");
    else if (action === "c") {
      state = setRequiredExecutable(state, state.requiredExecutable === "valid" ? "digest mismatch" : "valid");
    } else if (action === "u" || action === "porcupi uninstall") await runUninstall();
    else state = { ...state, lastResult: `Unknown action '${rawAction || "(blank)"}'.` };
  }
} finally {
  rl.close();
}
