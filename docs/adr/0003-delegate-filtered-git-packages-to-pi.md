# ADR 0003: Delegate filtered exact-commit Git packages to Pi

## Status

Accepted for global non-Patch Selection Intent in issue #14.

## Context

Pi v0.81.1 owns Git package checkout, npm dependency installation, updates, loading, and package identity. Its public `pi install <source>` command accepts a Git source and persists it, but it has no command-line options for choosing individual resources. Pi's documented settings object is the public mechanism for narrowing a package with `extensions`, `skills`, `prompts`, and `themes` filters.

Calling `pi install` first and adding filters afterward would briefly persist an unfiltered package, allowing every package resource to load if the process stopped between those writes. Reimplementing Pi's package manager inside PorcuPi would violate the v1 boundary.

## Decision

After final user confirmation, PorcuPi stages one exact-commit Pi package settings object with all four filter arrays and exact source-relative paths for the selected resources. It then invokes the active Managed Pi's public global `install` command for that exact source. Pi therefore owns checkout, npm, and package realization while retaining the already narrowed object form. A Pi package failure restores the prior settings bytes and saves no PorcuPi Selection Intent; when replacing an existing selection, PorcuPi also asks Pi to reconcile the checkout back to its prior exact commit.

PorcuPi separately retains only the Selection Intent needed to identify its source-wide choices: credential-free canonical Source Repository locator, exact commit, package source, Artifact kind, structural path, and global Installation Scope. Re-adding that locator verifies the prior filtered entry before replacing it. A matching Pi package entry that PorcuPi did not create is treated as foreign and is not adopted or overwritten.

Discovery follows the package manifest or root convention rules pinned by the supported Pi Base. The saved Pi filter is one package entry because Pi package identity ignores the Git ref.

## Consequences

- Pi remains the only package checkout/dependency/update/load implementation.
- Selected resources are never intentionally configured through an unfiltered intermediate state.
- Pi package settings remain shared user state, not PorcuPi-owned uninstallable state.
- Global scope is the only scope in this slice; project scope and Pi project-trust delegation are added in issue #15.
- PorcuPi must release alongside explicit updates when its pinned Pi Base changes package discovery or filter semantics.
