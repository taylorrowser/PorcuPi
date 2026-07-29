# ADR 0003: Delegate filtered exact-commit Git packages to Pi

## Status

Accepted for global and project non-Patch Selection Intent in issues #14 and #15.

## Context

Pi v0.81.1 owns Git package checkout, npm dependency installation, updates, loading, and package identity. Its public `pi install <source>` command accepts a Git source and persists it, but it has no command-line options for choosing individual resources. Pi's documented settings object is the public mechanism for narrowing a package with `extensions`, `skills`, `prompts`, and `themes` filters.

Calling `pi install` first and adding filters afterward would briefly persist an unfiltered package, allowing every package resource to load if the process stopped between those writes. Reimplementing Pi's package manager inside PorcuPi would violate the v1 boundary.

## Decision

After final user confirmation, PorcuPi stages an exact-commit Pi package settings object with all four filter arrays and exact source-relative paths for each effective scope. It then invokes the active Managed Pi's public `install` command for that exact source, adding `-l` only for project scope. Pi therefore owns checkout, npm, and package realization while retaining the already narrowed object form. PorcuPi never supplies Pi's `--approve` option or writes Pi's trust decisions.

When PorcuPi retains the same source in both scopes, its project entry uses `autoload: false`, Pi's documented delta form. This preserves the global filtered entry for the same package identity while enabling only the project-selected paths in that project. Both entries use the same exact commit. A project-only selection uses a normal filtered project entry so an unrelated global package with the same identity cannot become its checkout base.

A Pi package failure restores the prior settings bytes and saves no PorcuPi Selection Intent; when replacing or moving an existing selection, PorcuPi also asks Pi to reconcile the checkout in each affected scope back to its prior exact commit.

PorcuPi separately retains only the Selection Intent needed to identify its source-wide choices: credential-free canonical Source Repository locator, exact commit, package source, Artifact kind, structural path, Installation Scope, and the canonical project root needed to locate project settings. Re-adding that locator verifies prior filtered entries before replacing them. A matching Pi package entry that PorcuPi did not create is treated as foreign and is not adopted or overwritten.

Discovery follows the package manifest or root convention rules pinned by the supported Pi Base. The saved Pi filter is one package entry because Pi package identity ignores the Git ref.

## Consequences

- Pi remains the only package checkout/dependency/update/load implementation.
- Selected resources are never intentionally configured through an unfiltered intermediate state.
- Pi package settings remain shared user state, not PorcuPi-owned uninstallable state.
- Global and project entries can coexist without Pi's project package replacing selected global resources from the same source.
- Project package loading and missing-package realization remain guarded by Pi's own project-trust decision.
- PorcuPi must release alongside explicit updates when its pinned Pi Base changes package discovery or filter semantics.
