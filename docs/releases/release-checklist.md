# Release Installation maintainer checklist

Use this checklist for every npm-enabled PorcuPi release. GitHub is the canonical source and release record; npm publication must match it and does not create an independent release.

## One-time maintainer prerequisite

- [ ] Claim and retain control of the public **`porcupi` npm name** before documenting it as published or attempting a release.
- [ ] Restrict npm and GitHub publication credentials according to the maintainer access policy.

Name claiming and publication require a maintainer. Automated tests must not claim the name, publish a test package, or publish mutable test versions. Candidate acceptance runs `npm pack` and executes that exact local tarball through npm's package-execution path.

## Fix the release identity

- [ ] Choose one exact PorcuPi version and matching Git tag.
- [ ] Confirm `package.json`, `package-lock.json`, and `release/v<version>.json` agree on `porcupi@<version>`.
- [ ] Confirm the release record binds the canonical GitHub repository/tag, exact package-input SHA-256, Pi Base repository/tag/commit, fixed recipe, macOS/Linux support, and acceptance-report contract.
- [ ] Run `npm pack --json` and retain its filename, SHA-1 shasum, SHA-512 packed integrity, size, and file inventory.
- [ ] Confirm the packed inventory contains only declared release-fixed inputs and that no install lifecycle hook owns installed PorcuPi state.
- [ ] Do not modify v0.1.0 documentation, source tag, release record, or acceptance artifacts, and do not publish `porcupi@0.1.0`.

## Gate the public journeys

- [ ] Run focused checks and the complete ordinary test suite.
- [ ] Run the Release Installation workflow from the exact release tag with `--require-tag` enforced.
- [ ] Require all four packed jobs: macOS/Linux with Stock Pi absent/present.
- [ ] Require collision refusal, fresh install, v0.1.0 upgrade, launch, full verify, rollback, and uninstall to pass through public processes.
- [ ] Require both exact-source parity jobs on macOS/Linux.
- [ ] Require the separate real `pi-wait-for-user` source handoff gate when its accepted fixture is part of the release contract.
- [ ] Inspect every durable `report.json`, `report.md`, and referenced command log. Confirm exact package, packed integrity, repository revision/tag, Pi Base, fixture, platform, command, outcome, and duration identities.

## Publish without splitting identity

- [ ] Create the GitHub release from the accepted exact tag and attach or link the durable gate reports.
- [ ] Publish the already accepted tarball as `porcupi@<exact-version>`; do not rebuild from different source bytes.
- [ ] Compare registry name/version and integrity with the accepted package evidence.
- [ ] Run `npx --yes porcupi@<exact-version>` in a clean supported environment and retain the registry-backed report.
- [ ] Keep the exact-tag clone command as the advanced audit and fallback entrance.
- [ ] Do not make a mutable `latest` command the primary documented path and do not add unattended or automatic update behavior.
