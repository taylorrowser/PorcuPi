# ADR 0001: Zero-Patch public conformance

## Status

Accepted for the zero-Patch Managed Pi foundation in issue #13.

## Context

PorcuPi's first Pi Base is official Pi v0.81.1 at commit `20be4b18d4c57487f8993d2762bace129f0cf7c6`. The retained `pi-wait-for-user` recipe runs a built `pi conformance` command, but that command is introduced by a downstream Patch and does not exist in the exact, zero-Patch Pi Base. Applying that Patch implicitly would violate the requirement that zero selected Patches means the exact Pi Base.

The zero-Patch build still needs a fixed check through Pi's public CLI before immutable publication.

## Decision

The v0.81.1 zero-Patch recipe uses the built CLI's `--help` invocation as its public conformance check, then separately requires the exact `--version` and an isolated-home `--list-models` smoke run. The sequence remains private and release-fixed; it is not a build adapter or a Patch extension point.

A later recipe may invoke a richer public conformance command only when its pinned Pi Base provides that command without an implicitly selected Patch.

## Consequences

- A zero-Patch Managed Pi remains exactly the pinned official Pi Base.
- Installation detects a built CLI that cannot start through its public command surface before publication.
- The zero-Patch gate does not claim to validate downstream deferred-interaction behavior that is absent from the Pi Base.
