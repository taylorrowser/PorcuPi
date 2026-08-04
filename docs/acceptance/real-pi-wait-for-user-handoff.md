# Real `pi-wait-for-user` handoff release gate

## Gate identity

The release gate consumes these immutable inputs:

- PorcuPi: the exact checked-out Git revision reported by each run;
- Pi Base: `v0.81.1` at `20be4b18d4c57487f8993d2762bace129f0cf7c6`;
- Source Repository: `https://github.com/taylorrowser/pi-wait-for-user.git` at `1a987bca79a4f9475dd2037c18b2d6d7b7f68f25`;
- Question Tool: `@taylorrowser/pi-question-tool@0.1.5`, discovered at `packages/question-tool/extensions/question-tool.ts` through its independently versioned Pi package manifest; and
- implicit Patch Series: the 20 one-file series identities, member paths, and SHA-256 values in [`test/fixtures/real-handoff.json`](../../test/fixtures/real-handoff.json).

The fixture contains identities only. PorcuPi does not copy or bundle any `pi-wait-for-user` Patch or Question Tool bytes.

## Required matrix

[`.github/workflows/real-handoff-release-gate.yml`](../../.github/workflows/real-handoff-release-gate.yml) runs four independent journeys:

| Platform | Stock Pi fixture |
| --- | --- |
| macOS arm64 | absent |
| macOS arm64 | present on PATH, independently owned |
| Linux x64 | absent |
| Linux x64 | present on PATH, independently owned |

The fast deterministic `npm test` suite remains separate. The release gate is intentionally slower and networked because it clones and builds the exact real Pi Base and exact real Source Repository rather than replacing either with a local implementation fixture.

## Public-process journey

Every matrix job uses `install.sh` and the installed `~/.local/bin/porcupi`/optional `pi` commands as external processes. It does not import PorcuPi implementation helpers. The journey proves:

1. exact reference checkout, all 20 canonical Patch paths/digests, and the independently versioned Question Tool manifest;
2. bootstrap refusal of an unchanged foreign `porcupi` command, followed by clean default-No installation;
3. exact source/commit review, all-series selection and pending intent without activation, plus ordinary Pi installation of the independently versioned Question Tool package from the same exact checkout through the public Managed Pi command;
4. an intentional local incompatible-Patch preflight failure with byte-for-byte unchanged Activation, followed by removal of only that test intent;
5. successful composition of all 20 real Patches, public launch, and complete verification;
6. a second valid 19-series composition while a public Pi process leases the original base, proving cleanup deferral without process termination;
7. one-step local rollback to the retained complete 20-series Composition;
8. foreign `pi` collision refusal, successful enable/launch/disable, and Stock Pi preservation;
9. guided uninstall; and
10. complete before/after tree digests for shared global/project Pi settings, packages, credentials, sessions, trust/resources, plus byte-for-byte Stock Pi preservation.

No Windows, signing/channel, publisher authentication, background update, legacy adoption, or generalized build-adapter behavior is exercised or added by this gate.

## Durable report

Each matrix job uploads a 90-day GitHub Actions artifact containing `report.md` and the external-process log for every step. The report records:

- PASS/FAIL and per-step durations;
- exact PorcuPi revision, Pi Base, source commit, and Question Tool version;
- platform/architecture and Stock Pi scenario;
- Node.js version and the immutable Actions run URL; and
- release-gate environment requirements.

Run locally on macOS or Linux with:

```sh
npm run test:real-handoff -- --stock-pi=absent
npm run test:real-handoff -- --stock-pi=present
```

Requirements are Node.js 22.19 or newer, npm, Git, Python 3, network access to GitHub/npm, and enough temporary disk space for concurrent preflight/build checkouts. No model-provider credentials are required. Set `PORCUPI_KEEP_ACCEPTANCE_ROOT=1` to retain the isolated home and checkouts for diagnosis, or `PORCUPI_ACCEPTANCE_ROOT=/path` to choose their parent.

A PorcuPi revision is release-qualified only when all four matrix reports pass. Issue #23 must link the immutable passing Actions run and its reports as release evidence; this gate by itself does not publish a release or authorize deletion in `pi-wait-for-user`.
