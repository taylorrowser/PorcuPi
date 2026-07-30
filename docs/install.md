# Install PorcuPi v0.1.0

PorcuPi v0.1.0 is the first accepted PorcuPi v1 installation path for macOS and Linux. It builds one release-pinned Managed Pi without replacing Stock Pi.

## Before installing

You need Git, npm, and Node.js 22.19 or newer. Confirm them with:

```sh
git --version
npm --version
node --version
```

If this machine has a managed installation created by `pi-wait-for-user`, stop here and follow [the manual migration procedure](migration-from-pi-wait-for-user.md). The old manager must uninstall its own state before PorcuPi is installed.

## Bootstrap from the versioned source

Clone the exact release tag rather than a moving branch:

```sh
git clone --branch v0.1.0 --depth 1 https://github.com/taylorrowser/PorcuPi.git
cd PorcuPi
git rev-parse HEAD
./install.sh
```

Compare the printed commit with the commit attached to the [v0.1.0 GitHub release](https://github.com/taylorrowser/PorcuPi/releases/tag/v0.1.0) before continuing. `install.sh` is the release's bootstrap installer; it does not download a mutable PorcuPi runtime.

The three guided pages show the exact Pi Base, ask whether PorcuPi should own `pi`, and review the operation. The ownership choice defaults to **No**. Press Enter to advance and install, use arrows or `y`/`n` for the ownership choice, or press Escape to cancel.

The release verifies and builds official Pi `v0.81.1` at exact commit `20be4b18d4c57487f8993d2762bace129f0cf7c6` with the fixed `pi-v0.81.1-composition-v2` recipe. A successful installation publishes:

- an immutable Managed Pi Composition under PorcuPi's platform data root;
- the receipt-owned `~/.local/bin/porcupi` launcher; and
- only when explicitly selected, a reversible receipt-owned `~/.local/bin/pi` alias.

Add `~/.local/bin` to `PATH` yourself if the installer reports that it is missing. PorcuPi does not edit shell configuration.

## Supported starting states

### No Stock Pi

Accept the default **No** ownership choice to install only `porcupi`. No `pi` command is created. You may enable the optional alias later with `porcupi pi enable`.

### Stock Pi already installed

The default **No** choice leaves the independently installed Stock Pi and its command byte-for-byte unchanged. PorcuPi never stores, invokes, updates, uninstalls, or uses Stock Pi as a fallback.

Choosing **Yes** may publish `~/.local/bin/pi` only when that exact path is absent. It does not replace a Stock Pi file elsewhere. Disabling PorcuPi's alias later allows normal PATH resolution to find the independently managed command again.

### Foreign launcher collision

Installation fails closed if `~/.local/bin/porcupi` is already occupied by an unowned file, symbolic link, directory, or other entry. Optional `pi` ownership likewise refuses any foreign collision at `~/.local/bin/pi`. PorcuPi does not overwrite, adopt, rename, back up, or offer a force option. Inspect and resolve ownership outside PorcuPi, then retry; do not delete an entry unless you independently know who owns it.

## Trust and isolation

The release tag, exact Git commits, Patch SHA-256 values, receipts, and inventories provide reproducibility and local-corruption evidence. They do **not** provide publisher authentication, prove provenance, or authenticate the author of Git content. Verify GitHub transport and repository ownership according to your own trust policy.

Managed Pi, selected Patches, Pi packages, package dependencies, and fixed build commands execute with your user account's authority. PorcuPi does not sandbox them. Use an OS account, VM or container, or another external isolation boundary when that authority is inappropriate. PorcuPi never grants or pre-answers Pi project trust.

Continue with the [operations guide](operations.md) after installation. See the [v0.1.0 release notes](releases/v0.1.0.md) for exact release evidence and non-features.
