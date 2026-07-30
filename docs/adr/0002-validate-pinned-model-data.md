# ADR 0002: Validate pinned model data instead of refreshing it

## Status

Accepted for the Pi v0.81.1 build recipe in issue #13.

## Context

The pinned Pi Base commits a hydrated model catalog and an integrity manifest. Its `hydrate:model-data` command fetches mutable public provider catalogs and requires the current remote sets to agree with the historical structural catalog. That command succeeded for the retained reference release, but it is not replayable: during issue #13 acceptance, providers had added and withdrawn models since the pinned commit, so the command rejected the exact Pi Base.

Using current remote catalogs would make identical exact source inputs build differently over time. Updating the structural catalog would modify the zero-Patch Pi Base.

## Decision

PorcuPi vendors the model-data snapshot from the official `@earendil-works/pi-ai@0.81.1` npm package as private Pi Base recipe data. The Pi Base lock records that package's exact version and npm integrity plus the generated model-data manifest's SHA-256. Installation verifies the manifest, every declared regular data file, and the complete file set before hydration. The fixed PorcuPi recipe then parses the candidate's generated structural provider catalogs, selects only those exact provider/model identities from the verified snapshot, rejects every missing or API-incompatible identity, and writes a new deterministic manifest. Extra historical snapshot entries are excluded rather than fetched or silently added to the candidate structure. This fixed projection is necessary when selected Patches explicitly remove retired model identities; Patches cannot replace the projection algorithm or supply model bytes.

After that deterministic hydration step, PorcuPi runs the Pi Base's local `check:model-data` command. This validates the projected snapshot against the candidate source's structural catalog and generated file hashes without fetching mutable inputs. PorcuPi then runs `build:offline`, which repeats that validation as part of Pi's own offline package build.

The `pi-v0.81.1-composition-v2` recipe receipt binds the model-data identity, fixed structural projection semantics, and exact command. Future PorcuPi releases may pin a different model-data input and recipe, but an installation never refreshes model data from mutable provider catalogs.

## Consequences

- The exact Pi Base can be rebuilt after public model catalogs drift.
- The zero-Patch payload contains the model data committed by the pinned official Pi revision; a patched payload contains the exact structural subset selected from those same pinned bytes.
- Selected Patches may remove model identities through ordinary source changes, but cannot introduce an identity absent from the pinned snapshot or change its API binding without failing hydration.
- Model details may be historically stale, but they are reproducible and remain user-overridable through Pi's normal configuration.
- The retained reference's live hydration command is deliberately narrowed to deterministic validation rather than copied literally.
