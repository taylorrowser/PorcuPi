# ADR 0014: Filter every Artifact by exact Pi Base compatibility

## Status

Accepted for per-Artifact Pi Base compatibility in issue #48.

## Context

ADR 0004 permits exact Pi Base compatibility only on the `patches` presentation overlay for implicit one-file Patch Series. ADR 0013 adds declared Patch Series but deliberately defers compatibility for those series and for Pi resources. A mixed Source Repository needs to remain useful when only some Artifacts support PorcuPi's release-pinned Pi Base, without making source metadata a build interface or treating an author's declaration as proof that code works.

Compatibility metadata also needs a concise source-wide default. A per-Artifact declaration must be able to replace that default because one resource or Patch Series may support a different exact set. Missing or malformed optional metadata must not suppress convention or Pi-manifest discovery.

## Decision

The regular root `porcupi.json` schema 1 accepts optional `supportedPiBaseVersions` and `supportedPiBaseCommits` fields as the source-wide compatibility default. Each field is a nonempty array of unique exact values: release versions for the former and full SHA-1 or SHA-256 commit object IDs for the latter. If both dimensions are declared, both must contain the release's exact Pi Base.

The existing `patches` entries may continue to carry those fields for implicit one-file Patch Series. Declared `patchSeries` entries may now carry the same fields. A new `resources` array overlays already discovered Extensions, Skills, Prompts, and Themes by the closed identity `{ kind, path }`; it never adds an Artifact or changes Pi's package manifest and convention discovery.

An Artifact entry that declares either compatibility field replaces the complete source default; the default and override are not dimension-wise merged. An entry with no compatibility fields inherits the source default. If neither the source nor the Artifact declares compatibility, there is no author restriction and discovery remains unchanged.

PorcuPi evaluates the effective declaration against the exact Pi Base before presenting selection. A mismatch remains visible but disabled in the add flow. Re-adding another exact source commit cannot carry a retained selection into an incompatible Artifact. Exact-source staging for apply and Upgrade Readiness also re-evaluates selected Artifacts and rejects a mismatch before Patch or package advancement.

A match only passes this author-declared filter. Patch staging, digest verification, sequential preflight, fixed target build, pinned model-data and resource validation, public conformance, exact version, and smoke checks remain release-owned and mandatory where applicable. Compatibility is not retained as Selection Intent and supplies no authorization to skip verification.

The metadata schema remains closed. Root, Patch, Patch Series, and resource entries reject unknown fields. Malformed JSON, unsafe values, duplicate identities, empty or duplicate compatibility arrays, ranges, partial commit IDs, and unsupported kinds invalidate and visibly ignore the whole overlay. A structurally valid entry naming an unavailable discovered Artifact is diagnosed and ignored individually. Invalid metadata supplies no executable fallback and suppresses no convention-discovered Artifact or Patch File.

Metadata cannot declare commands, hooks, dependencies, recipes, force options, custom verifiers, activation policy, scripts, or any other source-supplied behavior.

## Consequences

- Source authors can state a common exact Pi Base policy once and narrow or broaden individual Artifacts with complete overrides.
- Mixed-compatibility Source Repositories expose compatible resources and Patch Series without allowing incompatible choices.
- Metadata omission preserves zero-configuration discovery.
- Compatibility declarations provide early rejection, not runtime correctness evidence.
- Pi continues to own resource package discovery and lifecycle; PorcuPi's fixed composition and verification pipeline remains authoritative for Patch Series.
- Future Tracked Branch and Post-release Compatibility work can compare effective compatibility as selected content without changing this eligibility contract.
