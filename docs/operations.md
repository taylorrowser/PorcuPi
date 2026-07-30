# PorcuPi v0.1.0 operations

PorcuPi intentionally has a small public command surface. There is no release channel, background updater, generalized adapter, arbitrary retention control, or Windows command path.

## Launch Managed Pi

```sh
porcupi
porcupi --version
porcupi --model openai/gpt-5
```

Arguments not recognized as PorcuPi lifecycle commands are forwarded unchanged to the active Managed Pi. Launch validates the active identity and required executable, claims a Composition process lease, and retains it for the Pi child process lifetime. Corruption fails closed; PorcuPi does not run the previous Composition or Stock Pi as fallback.

## Add exact source intent

```sh
porcupi add https://github.com/example/pi-resources@main
porcupi add https://github.com/example/pi-resources@0123456789abcdef0123456789abcdef01234567
porcupi add
```

The guided flow resolves a ref to one full Git commit before review. It lets you select Pi Skills, Extensions, Prompts, and Themes and assign global or current-project scope. Pi performs its public package lifecycle; PorcuPi does not approve project trust or replace Pi's package behavior.

Tracked regular `patches/**/*.patch` files appear in the same selection flow. Their intent records exact repository, commit, path, and SHA-256 identity. They have no Pi Installation Scope and are never installed as Pi packages.

## Review or change retained intent

```sh
porcupi manage
```

Manage reviews every retained Source Repository, removes selections, and moves Pi resources between global and project scope. It preserves unrelated Pi settings. Add and manage save **pending Patch intent** only: they never rebuild or activate Managed Pi.

## Apply pending Patches

```sh
porcupi apply
```

Apply previews the complete canonical Patch order and exact identities. After confirmation it verifies and sequentially preflights the same staged bytes, runs the release's fixed build and verification recipe, publishes a complete immutable Composition, and atomically activates it. The former active Composition becomes the one previous target. Any failure before activation leaves active and previous unchanged.

Selecting zero Patches and applying returns to the exact release Pi Base. Applying an identity that is already active is a verified no-op.

## Verify the active installation

```sh
porcupi verify
```

Verify performs the complete payload and runtime inventory audit and reruns executable identity, version, public help, and isolated-home smoke checks. It also verifies the stable launcher and any receipt-owned `pi` alias. Verification reports corruption but never repairs or replaces modified content.

## Roll back one Composition

```sh
porcupi rollback
```

Rollback previews and fully verifies the one retained previous Composition, then atomically swaps active and previous after confirmation. It performs no fetch or build and leaves resource and Patch Selection Intent unchanged. There is no arbitrary rollback target or retention setting.

## Enable or disable optional `pi` ownership

```sh
porcupi pi enable
porcupi pi disable
```

Enable immediately attempts to publish the exact receipt-owned `~/.local/bin/pi` alias and refuses every collision. Disable removes only an unchanged matching owned alias. It remains available as a recovery command when active Managed Pi state is corrupt, but it never removes a foreign or modified entry. Neither command edits PATH or mutates Stock Pi.

## Uninstall PorcuPi-owned state

```sh
porcupi uninstall
```

The guided uninstall inventories exact PorcuPi targets and separately reports Pi-owned resource configuration that will remain. It preflights all ownership evidence before deletion and fails closed if any target is malformed, modified, symbolic, foreign, or escaping its root. A live Composition lease defers uninstall without terminating Pi; retry after that process exits.

Uninstall removes only receipt-proven PorcuPi launchers, runtime, state, and Compositions. It retains Pi global/project package configuration, package data, credentials, sessions, trust/resources, and Stock Pi. An interrupted confirmed uninstall is retried with the same command and converges through PorcuPi's receipt-owned recovery launcher.

## Lifecycle and recovery boundaries

Install, apply, rollback, cleanup, optional command ownership, and uninstall share one lifecycle lock. Ordinary launch does not take that lock. If a mutating command reports a live owner, let that operation complete instead of deleting lock or state files manually.

For a refused launch:

1. run `porcupi verify` for a complete diagnosis;
2. use `porcupi rollback` only when the retained previous Composition is healthy;
3. use `porcupi pi disable` to remove an unchanged receipt-owned alias if `pi` currently resolves to PorcuPi; and
4. invoke independently managed Stock Pi by its own known path when needed.

PorcuPi never automatically chooses a fallback executable.
