# Migrate manually from `pi-wait-for-user`

PorcuPi v0.1.0 does not adopt, convert, move, or delete state or payloads owned by the old `pi-wait-for-user` manager. The only supported order is: **run the old manager's own uninstall before installing PorcuPi**.

Historical `pi-wait-for-user` tags and releases remain immutable so an existing installation can execute its own uninstall path. Do not install PorcuPi over the old managed root and do not copy old Activation, receipt, payload, channel, trust, or launcher state into PorcuPi.

## 1. Uninstall with the old manager

While the old Managed Installation still owns its command, run:

```sh
command -v pi
pi managed uninstall
```

Review the old manager's output. Its receipt-safe uninstall preserves Stock Pi and shared Pi settings, credentials, packages, sessions, and project data. If it reports live leased processes, let those processes exit and run `pi managed uninstall` again. Do not terminate cleanup by manually removing managed directories or launchers.

### Preserve a human-owned entry refused by uninstall

The old manager fails before deleting anything when its root contains a path it cannot prove it owns. For example, a locally created signing directory produces:

```text
managed-manager: Foreign Managed Installation root path: production-signing-private
```

Do not delete that directory or the managed root. First release the receipt-owned `pi` command while the old dispatcher still resolves:

```sh
pi managed disable
hash -r 2>/dev/null || true
command -v pi || true
```

Then inspect the named foreign entry and preserve it at a secure destination **outside the old managed root**. The following example applies only when `production-signing-private` is known to be human-owned and the destination does not already exist:

```sh
legacy_root="$HOME/Library/Application Support/pi-wait-for-user"
preserved="$HOME/Library/Application Support/pi-wait-for-user-production-signing-private"

test -d "$legacy_root/production-signing-private"
test ! -e "$preserved"
mv "$legacy_root/production-signing-private" "$preserved"
```

After `pi managed disable`, use the remaining compatibility command to retry the old manager's receipt-safe uninstall:

```sh
pi-wait-for-user managed uninstall
hash -r 2>/dev/null || true
command -v pi || true
command -v pi-wait-for-user || true
```

If uninstall reports another foreign entry, stop and establish who owns it before moving it. Never delete, rename, or move one of the manager's recognized directories merely to bypass validation.

If the old manager cannot execute its uninstall after its human-owned entries are safely outside the managed root, use the recovery and uninstall instructions from the exact historical `pi-wait-for-user` release that installed it. PorcuPi is not a recovery tool for legacy state.

After successful uninstall, start a new shell or clear the shell's command lookup cache, then inspect resolution again:

```sh
hash -r 2>/dev/null || true
command -v pi || true
```

The result may be an independently installed Stock Pi or no `pi` command. It must not be the old managed dispatcher.

## 2. Install the versioned PorcuPi release

Follow [Install PorcuPi v0.1.0](install.md). The installer creates a new PorcuPi ownership root and defaults to leaving `pi` independently resolved.

PorcuPi does not adopt legacy Selection Intent. Select source content explicitly after installation.

## 3. Select the exact `pi-wait-for-user` source

The first accepted handoff was qualified at exact source commit `1a987bca79a4f9475dd2037c18b2d6d7b7f68f25`:

```sh
porcupi add https://github.com/taylorrowser/pi-wait-for-user@1a987bca79a4f9475dd2037c18b2d6d7b7f68f25
```

Review and select the desired Patches. Saving this choice creates pending intent only. Build and activate it explicitly:

```sh
porcupi apply
porcupi verify
```

The source's Question Tool is an independently versioned ordinary Pi package, not an automatic Patch dependency or privileged PorcuPi input. If desired, check out the same exact source commit and install its package directory through Managed Pi's normal package command:

```sh
git clone https://github.com/taylorrowser/pi-wait-for-user.git
cd pi-wait-for-user
git checkout --detach 1a987bca79a4f9475dd2037c18b2d6d7b7f68f25
porcupi install "$PWD/packages/question-tool"
```

Pi owns that package configuration, dependency installation, loading, update behavior, and trust boundary. PorcuPi uninstall intentionally leaves it and other Pi-owned resources in place.

## What does not migrate

There is no automatic or in-place migration of:

- old manager or downstream payloads;
- Activation, rollback, retention, update-hold, channel, signing, attestation, or provenance state;
- old manager launchers or command-ownership receipts; or
- legacy source selection or package intent.

PorcuPi has no legacy adoption switch, force flag, release channel, background update path, or Stock Pi fallback. This explicit uninstall-then-install boundary keeps each manager responsible only for state it can prove it owns.
