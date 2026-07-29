# ADR 0002: Validate pinned model data instead of refreshing it

## Status

Accepted for the Pi v0.81.1 build recipe in issue #13.

## Context

The pinned Pi Base commits a hydrated model catalog and an integrity manifest. Its `hydrate:model-data` command fetches mutable public provider catalogs and requires the current remote sets to agree with the historical structural catalog. That command succeeded for the retained reference release, but it is not replayable: during issue #13 acceptance, providers had added and withdrawn models since the pinned commit, so the command rejected the exact Pi Base.

Using current remote catalogs would make identical exact source inputs build differently over time. Updating the structural catalog would modify the zero-Patch Pi Base.

## Decision

PorcuPi vendors the model-data snapshot from the official `@earendil-works/pi-ai@0.81.1` npm package as private Pi Base recipe data. The Pi Base lock records that package's exact version and npm integrity plus the generated model-data manifest's SHA-256. Installation verifies the manifest, every declared regular data file, and the complete file set before copying the snapshot into the exact checkout.

After that deterministic hydration step, PorcuPi runs the Pi Base's local `check:model-data` command. This validates the snapshot against the source's structural catalog and pinned file hashes without fetching mutable inputs. PorcuPi then runs `build:offline`, which repeats that validation as part of Pi's own offline package build.

The recipe receipt binds the model-data identity and exact command. Future PorcuPi releases may pin a different model-data input and recipe, but an installation never refreshes model data from mutable provider catalogs.

## Consequences

- The exact Pi Base can be rebuilt after public model catalogs drift.
- The zero-Patch payload contains the model data committed by the pinned official Pi revision.
- Model availability may be historically stale, but it is reproducible and remains user-overridable through Pi's normal configuration.
- The retained reference's live hydration command is deliberately narrowed to deterministic validation rather than copied literally.
