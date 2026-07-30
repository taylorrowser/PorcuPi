# Use and publish PorcuPi Source Repositories

This guide explains how to consume a Source Repository with PorcuPi v0.1.0 and how to make Extensions, Skills, prompt templates, Themes, and Patches discoverable from one. It covers the source contract; use the [installation guide](install.md) to install PorcuPi and the [operations guide](operations.md) for lifecycle recovery.

PorcuPi has two intentionally different integration paths:

- **Pi resources**—Extensions, Skills, prompt templates, and Themes—remain ordinary Pi package resources. PorcuPi presents individual choices and scopes, then delegates checkout, dependencies, configuration, loading, and project trust to Pi's public package lifecycle.
- **Patches** are declarative Git patch files selected as pending PorcuPi intent. Only `porcupi apply` composes selected Patches into a new immutable Managed Pi Composition.

A repository may contain either kind or both. There is no PorcuPi package registry, dependency graph, source-defined build hook, or automatic relationship between a resource and a Patch.

## Use a Source Repository

### 1. Inspect and identify the source

Review the source before selecting it. Pi Extensions and Patch-modified Pi code run with your user authority. Record the full commit you intend to use rather than relying on a moving branch:

```sh
git clone https://github.com/example/pi-resources.git
cd pi-resources
git status --short
git rev-parse HEAD
```

PorcuPi accepts credential-free HTTPS, SSH, Git protocol, and `git:` shorthand locators. A ref may be a branch, tag, or full commit, but PorcuPi always resolves it to one full commit before review. A full commit is the clearest reproducible input:

```sh
source_commit=$(git rev-parse HEAD)
porcupi add "https://github.com/example/pi-resources@$source_commit"
```

Do not put credentials in the locator. Use normal Git credential or SSH configuration when authentication is required.

### 2. Select Artifacts

The guided add flow shows every supported Artifact PorcuPi discovers at that exact commit:

- Extension
- Skill
- Prompt
- Theme
- Patch

Select only the Artifacts you reviewed. Resources receive an Installation Scope on the next page. Patches do not have scope because they are not Pi packages.

On confirmation:

- selected resources are written as exact-path filters in Pi's package settings and realized through Pi's public `install` command; and
- selected Patches are saved as exact repository, commit, path, and SHA-256 Selection Intent.

Cancellation or a failed Pi package operation saves no replacement intent. Re-adding the same canonical repository reviews and replaces that repository's complete previous selection rather than silently merging it.

### 3. Choose resource scope

A resource may have **user-global** or **project-local** Installation Scope:

- user-global resources use Pi's user settings;
- project-local resources use the current project's `.pi/settings.json` and Pi's `-l` package lifecycle; and
- one source may have different selected paths in both scopes.

PorcuPi does not grant or remember project trust and never answers Pi's trust prompt. A project resource becomes loadable only under Pi's own trust decision. Run `porcupi add` from the intended project root before choosing project scope.

### 4. Apply pending Patches

Adding or managing Patches never rebuilds Managed Pi. If selection differs from the active Composition, PorcuPi reports **pending Patch intent**. Review and compose it explicitly:

```sh
porcupi apply
```

Apply shows the complete cross-repository order and exact identities, revalidates the source commit and Patch digests, sequentially preflights the same bytes, builds through PorcuPi's fixed recipe, verifies the candidate, and only then activates it. A failure leaves the active and previous Compositions unchanged.

Resource-only changes do not require `porcupi apply` because Pi owns their package lifecycle.

### 5. Change or remove selections

Use the retained exact commit without resolving a new source when removing selections or changing resource scope:

```sh
porcupi manage
```

Resource changes are reconciled through Pi when confirmed. Patch changes remain pending until the next `porcupi apply`. Selecting zero Patches and applying returns Managed Pi to PorcuPi's exact zero-Patch Pi Base.

To advance a source, add it again at a new branch, tag, or full commit and review the complete replacement:

```sh
porcupi add https://github.com/example/pi-resources@NEW_FULL_COMMIT
```

Ordinary Pi package updates do not advance PorcuPi's pinned Git ref. PorcuPi never silently retargets saved Artifacts whose paths, source identity, or Patch digests changed.

## Prepare a Source Repository

Start with a Git repository. PorcuPi discovers only content present in the resolved commit, so add and commit every resource, Patch, manifest, and optional metadata file before testing through `porcupi add`.

A repository using every supported kind might look like this:

```text
pi-resources/
├── package.json
├── porcupi.json
├── extensions/
│   └── example.ts
├── skills/
│   └── review/
│       └── SKILL.md
├── prompts/
│   └── explain.md
├── themes/
│   └── example.json
└── patches/
    ├── 0001-add-core-capability.patch
    └── 0002-expose-capability-to-extensions.patch
```

A source does not need every directory. Prefer one root Pi package manifest when publishing resources with dependencies or nonconventional paths. Keep Patch metadata in the separate optional root `porcupi.json`; `package.json` cannot declare Patches, and `porcupi.json` cannot declare Pi resources.

### Resource discovery choices

PorcuPi v0.1.0 mirrors the package rules of its supported Pi Base, v0.81.1:

1. If the root regular `package.json` contains a `pi` object, that manifest controls resource discovery. Conventional directories are not additionally scanned.
2. Otherwise, PorcuPi uses the root convention directories described below.
3. Convention scans skip hidden entries, `node_modules`, and content excluded by repository ignore files. Every discovered resource must resolve to a regular nonsymbolic file inside the repository.
4. Patches are discovered independently under `patches/`, whether or not a Pi manifest exists.

For an explicit package, use source-relative paths or globs:

```json
{
  "name": "example-pi-resources",
  "private": true,
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["extensions/**/*.ts", "!extensions/internal/**"],
    "skills": ["skills"],
    "prompts": ["prompts"],
    "themes": ["themes"]
  }
}
```

Manifest paths must remain inside the repository. Positive entries establish what the package may load; `!` patterns exclude from that set. PorcuPi stores plain exact source-relative paths for the resources the user selects, so the resulting Pi filters narrow rather than broaden the manifest.

A malformed root manifest produces diagnostics and can leave its resources undiscoverable. Validate the exact committed source before publishing it.

## Extensions

An Extension is a regular `.ts` or `.js` module with a default factory export accepted by Pi v0.81.1. PorcuPi selects and configures it but does not define or wrap the Extension API.

The simplest convention-only source is:

```text
extensions/
├── notify.ts
└── review/
    └── index.ts
```

Without a root `pi` manifest, PorcuPi discovers direct `.ts`/`.js` files under `extensions/` and `index.ts`/`index.js` entry points in its immediate subdirectories. An immediate subdirectory may instead contain its own `package.json#pi.extensions`; when that nested list is valid and finds entries, those extension paths are used relative to the subdirectory instead of its conventional index. For more complex root layouts, dependencies, or explicit entry points, prefer one root manifest:

```json
{
  "name": "example-extension-package",
  "private": true,
  "keywords": ["pi-package"],
  "dependencies": {
    "example-runtime": "1.2.3"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "pi": {
    "extensions": ["src/example-extension.ts"]
  }
}
```

Put third-party runtime imports in `dependencies` and commit the package lock used to validate them. Do not rely on `devDependencies` at runtime. Pi-provided packages such as `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, and `typebox` belong in `peerDependencies` with `"*"` when imported. Pi runs package dependency installation for Git packages; PorcuPi does not implement a second dependency installer.

A minimal Extension entry point is:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function exampleExtension(pi: ExtensionAPI) {
  pi.registerCommand("example", {
    description: "Show that the extension loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Example extension loaded", "info");
    },
  });
}
```

Develop and test against the API exposed by PorcuPi's exact Pi Base. See Pi v0.81.1's [Extension guide](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/extensions.md), [package guide](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/packages.md), and working [Extension examples](https://github.com/earendil-works/pi/tree/v0.81.1/packages/coding-agent/examples/extensions). If an Extension requires a selected Patch, document that requirement for users; PorcuPi does not infer or enforce it.

## Skills

Without a root manifest, PorcuPi discovers:

- `skills/<name>/SKILL.md`, recursively; and
- top-level Markdown files directly under `skills/`.

Each loadable Skill must have frontmatter with a non-empty `description`:

```md
---
name: review
description: Review a change for correctness and maintainability.
---

# Review

Follow the project's review standards and report actionable findings.
```

Use the root `pi.skills` manifest array when Skills live elsewhere or when the package should expose only an explicit subset. See Pi v0.81.1's [Skills guide](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/skills.md) for authoring semantics.

## Prompt templates

Without a root manifest, PorcuPi recursively discovers `.md` files beneath `prompts/`. A prompt may be plain Markdown or contain valid, closed frontmatter. For example:

```md
---
description: Explain the selected code
---

Explain this code's responsibilities, invariants, and failure behavior: $@
```

Use the root `pi.prompts` manifest array for nonconventional locations or an explicit subset. See Pi v0.81.1's [prompt-template guide](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/prompt-templates.md).

## Themes

Without a root manifest, PorcuPi recursively discovers `.json` files beneath `themes/`. The file must satisfy Pi v0.81.1's Theme shape, including a unique nonempty `name`, supported `vars`, and all required color fields. Invalid Theme JSON is diagnosed rather than offered for selection.

Use the root `pi.themes` manifest array for nonconventional locations or an explicit subset. Start from Pi v0.81.1's [Theme guide and examples](https://github.com/earendil-works/pi/blob/v0.81.1/packages/coding-agent/docs/themes.md) rather than inventing a partial color object.

## Patches

A Patch is a declarative Git-compatible file that changes PorcuPi's exact Pi Base. It is not an Extension, a script, or a package lifecycle hook.

### Target the exact Pi Base

PorcuPi v0.1.0 composes Patches onto:

- repository: `https://github.com/earendil-works/pi.git`
- tag: `v0.81.1`
- commit: `20be4b18d4c57487f8993d2762bace129f0cf7c6`

Create and test changes from that commit:

```sh
PI_BASE=20be4b18d4c57487f8993d2762bace129f0cf7c6
git clone https://github.com/earendil-works/pi.git /tmp/pi-patch-work
cd /tmp/pi-patch-work
git checkout --detach "$PI_BASE"
git switch -c example-change
# Edit and test the Pi source, then commit the coherent change.
git add --all
git commit -m "feat: add example capability"
```

Keep each selectable Patch coherent. If a change adds or alters npm dependencies, include the corresponding lockfile changes so PorcuPi's fixed `npm ci` build remains valid. A Patch cannot replace PorcuPi's dependency, build, hydration, conformance, or smoke commands.

### Generate Patch files

Generate a Git-compatible Patch into the Source Repository. One committed change per numbered file makes review and ordering explicit:

```sh
SOURCE=/absolute/path/to/pi-resources
git -C /tmp/pi-patch-work format-patch \
  -1 --stdout --binary --full-index HEAD \
  > "$SOURCE/patches/0001-add-example-capability.patch"
git -C "$SOURCE" add patches/0001-add-example-capability.patch
```

PorcuPi recursively discovers only tracked files whose paths begin with `patches/` and end with `.patch`. Candidates must be regular Git mode `100644` or `100755` files in the checkout. Symbolic links, submodules, special modes, unsafe/control paths, non-regular files, and repository-boundary escapes are rejected.

Names determine order. PorcuPi orders the complete selected series by canonical Source Repository locator and then full source-relative Patch path. Within one source, use zero-padded names such as `0001-...patch`, `0002-...patch`, and put prerequisite changes first. There is no dependency metadata or order override.

### Preflight the intended series

Check whitespace and apply each Patch to the result of the prior one, just as PorcuPi's preflight does:

```sh
SOURCE=/absolute/path/to/pi-resources
PI_BASE=20be4b18d4c57487f8993d2762bace129f0cf7c6
git clone https://github.com/earendil-works/pi.git /tmp/pi-patch-check
git -C /tmp/pi-patch-check checkout --detach "$PI_BASE"

git -C "$SOURCE" ls-files ':(glob)patches/**/*.patch' | LC_ALL=C sort |
while IFS= read -r patch; do
  git -C /tmp/pi-patch-check apply --check --whitespace=error-all "$SOURCE/$patch"
  git -C /tmp/pi-patch-check apply --whitespace=error-all "$SOURCE/$patch"
done
```

This is a fast source check, not a substitute for `porcupi apply`. The authoritative apply re-resolves exact source commits, verifies digests, stages owner-controlled bytes, preflights the complete cross-source selection, runs the fixed build, and smoke-tests the candidate.

### Add optional Patch metadata

Patches need no manifest to be discovered. An optional regular root `porcupi.json` may add only display text and exact Pi Base compatibility:

```json
{
  "schemaVersion": 1,
  "patches": [
    {
      "path": "patches/0001-add-example-capability.patch",
      "displayName": "Example capability",
      "description": "Adds the core capability used by the example Extension.",
      "supportedPiBaseVersions": ["v0.81.1"],
      "supportedPiBaseCommits": [
        "20be4b18d4c57487f8993d2762bace129f0cf7c6"
      ]
    }
  ]
}
```

The schema is deliberately closed:

- the root permits only `schemaVersion` and `patches`;
- an entry permits only `path`, `displayName`, `description`, `supportedPiBaseVersions`, and `supportedPiBaseCommits`;
- paths must identify convention-discovered regular Patch files;
- display text must be nonempty and contain no control characters;
- compatibility arrays must be nonempty sets of unique exact release versions or full Git object IDs; and
- when both compatibility dimensions are present, both must match PorcuPi's Pi Base.

A declared mismatch disables that Patch in selection. Omitted compatibility leaves PorcuPi's fixed preflight/build pipeline authoritative. Metadata never creates a Patch Artifact and cannot declare dependencies, hooks, scripts, ordering, ranges, recipes, verifiers, or force behavior.

Malformed JSON, unknown fields, duplicate entries, unsafe values, or invalid compatibility invalidate and visibly ignore the whole metadata overlay while leaving convention-discovered Patches available. A valid entry naming a file that was not discovered is diagnosed and ignored individually.

## Validate the source

Before publishing a commit, check all of the following.

### Repository checks

- Every intended file is tracked: `git status --short` is empty after commit.
- The exact commit is available from the locator users will enter.
- No selected path depends on an untracked file, symbolic link, submodule, ignored output, or file outside the repository.
- A root `package.json#pi` manifest explicitly includes every resource intended for selection.
- Resource paths, globs, exclusions, runtime dependencies, and peer dependencies follow Pi v0.81.1's package contract.
- Skills include a loadable `description`; prompts have closed frontmatter; Themes satisfy the complete supported format; Extensions export valid Pi factories.
- Each Patch applies sequentially with `git apply --check --whitespace=error-all` to the exact Pi Base.
- `porcupi.json`, if present, uses only schema version 1 and narrow Patch presentation/compatibility fields.

### End-to-end check

Commit the source, push the exact commit, and exercise the same public path users will use:

```sh
source_commit=$(git rev-parse HEAD)
porcupi add "https://github.com/example/pi-resources@$source_commit"
```

Confirm that:

1. the selection page shows every intended Artifact and no unintended one;
2. PorcuPi shows no ignored-manifest, unsafe-path, format, or compatibility diagnostics;
3. global and project resource choices install successfully through Pi;
4. the Managed Pi can list or exercise each selected resource;
5. Patch changes are reported as pending rather than activated by add; and
6. `porcupi apply` successfully preflights, builds, verifies, and activates the intended complete series.

Then run:

```sh
porcupi verify
```

If a package only works with a Patch, test both the expected failure/disable behavior without that Patch and successful behavior with it. Document the relationship for users because PorcuPi intentionally does not model dependencies between Artifacts.

## Publish and update

Publish the Git commit without rewriting it. Give consumers the credential-free repository locator and full commit:

```text
https://github.com/example/pi-resources@0123456789abcdef0123456789abcdef01234567
```

A tag can provide a memorable name, but users should review the full commit PorcuPi resolves. Commit hashes and Patch SHA-256 values provide reproducibility and local-corruption evidence; they do not authenticate you as publisher.

For an update:

1. start from the same supported Pi Base when changing Patches;
2. update resources, Patch files, tests, documentation, and exact compatibility metadata together;
3. rerun source and end-to-end checks;
4. publish a new immutable commit; and
5. tell users to run `porcupi add <source>@<new-commit>` and review the complete replacement.

Changing Patch bytes changes their SHA-256 identity. Moving a resource changes its structural identity. PorcuPi surfaces those changes rather than silently migrating saved intent. Do not rewrite a published commit or tell users that a moving branch is equivalent to an exact release.

## Trust and project scope

PorcuPi is a composition and lifecycle tool, not a publisher-authentication or sandbox system:

- Extensions, package installation scripts, and dependencies execute with the user's authority.
- Skills and prompts can direct a model to take consequential actions.
- Patches change the code built into the active Managed Pi Composition.
- Exact commits, digests, inventories, and receipts detect identity changes and local corruption but do not prove provenance.
- Project resources remain subject to Pi's project-trust flow; PorcuPi never supplies `--approve`, writes trust state, or answers the prompt.
- A source should not request credentials in its Git URL or claim that PorcuPi has authenticated its publisher.

Review third-party source before selection. Use a separate OS account, VM, container, or another external boundary when the source should not receive your normal user authority.

## Further reference

- [PorcuPi operations](operations.md)
- [Filtered exact-commit Pi package decision](adr/0003-delegate-filtered-git-packages-to-pi.md)
- [Patch discovery and metadata decision](adr/0004-narrow-patch-metadata.md)
- [Fixed Patch composition pipeline](adr/0005-fixed-patch-composition-pipeline.md)
- [Real `pi-wait-for-user` Source Repository](https://github.com/taylorrowser/pi-wait-for-user)
- [Its complete `porcupi.json` example](https://github.com/taylorrowser/pi-wait-for-user/blob/main/porcupi.json)
