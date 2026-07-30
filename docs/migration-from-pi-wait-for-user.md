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

If the old manager cannot execute its uninstall, use the recovery and uninstall instructions from the exact historical `pi-wait-for-user` release that installed it. PorcuPi is not a recovery tool for legacy state.

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
