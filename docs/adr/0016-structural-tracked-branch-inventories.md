# ADR 0016: Compare bounded structural inventories for Tracked Branch updates

## Status

Accepted for filtered and coalesced Tracked Branch candidates in issue #51. This completes the candidate-identity part deferred by ADR 0015; background availability and status work remains deferred.

## Context

A Tracked Branch can move because of documentation, tests, or an independent Artifact the user did not select. Treating every commit as an update is noisy. Inferring arbitrary source imports, scripts, build inputs, or runtime filesystem reads would instead make PorcuPi an incomplete language and program analyzer.

Users still need a deliberate way to adopt the newest exact branch commit when its selected content is structurally unchanged. Acceptance must remain bound to one exact source-wide snapshot and must not authorize mutation after the branch moves again.

## Decision

PorcuPi compares one bounded structural fingerprint for current Selection Intent at the accepted and candidate commits. A directory Skill includes every tracked regular file beneath its directory; a top-level single-file Skill includes only that file. A convention-discovered directory Extension includes its tracked regular-file tree. Standalone Extensions, Prompts, and Themes include only their selected file. An implicit Patch Series includes its member, while a declared Patch Series includes exactly its ordered declared members. Every Artifact fingerprint also includes its kind, stable structural identity, and effective exact Pi Base compatibility.

A `porcupi.json` resource entry may declare `content`, a nonempty unique list of safe exact file or directory paths. The entry still overlays an already Pi-discovered resource and must cover its selected structural path. It cannot discover a resource or declare execution, dependencies, or policy. Declared directories recurse only through tracked `100644` and `100755` regular files. Unsafe paths, symbolic links, submodules, special modes, missing content, and repository escapes are invalid rather than followed.

For a selected Pi resource, the fingerprint also compares only the applicable package manifest's exact dependency fields, exact npm install-lifecycle script declarations, and applicable committed npm lock bytes. PorcuPi does not parse their meaning or trace imports, scripts, workspaces, dependency graphs, build inputs, or runtime file access. Conservative noise from these bounded shared inputs is accepted.

`porcupi manage` automatically offers review only when this fingerprint changes. It also exposes an explicit guided latest-commit action when the branch advanced but the fingerprint did not. One accepted candidate replaces that source's complete desired snapshot, including any older pending Patch snapshot, while other sources remain intact. Immediately before package or Selection Intent mutation, PorcuPi re-resolves the Tracked Branch and requires the exact reviewed commit and fingerprint to remain current.

A missing, renamed, malformed, incompatible, or invalid selected Artifact blocks advancement with a visible diagnosis. Non-fast-forward branch movement remains refused by ADR 0015.

## Consequences

- Documentation, tests, unrelated files, and independent unselected Artifacts remain quiet.
- Colocated or explicitly declared supporting files and bounded package inputs can produce a conservative candidate without source-language analysis.
- An undeclared helper outside the structural inventory can be missed; maintainers must colocate it, declare it as content, or ask users to force a latest-commit review.
- Pending Selection Intent remains a complete latest desired snapshot rather than a queue of source deltas.
- Final branch movement invalidates review instead of guessing which commit the user intended to accept.
