# Command reference

Run one command and persist its result:

```sh
cordn --state-file <path> --command "<command>"
```

Or start the interactive REPL:

```sh
cordn --state-file <path>
```

## REPL commands

```text
help
status
whoami    (prints the private identity key)
gen-kp [alias] [--coordinator <pubkey>] [--last-resort] [--local-only]
publish-kp <alias> [--coordinator <pubkey>]
key-packages | kps
delete-kp <aliasOrKeyPackageRef> [--local-only] [--coordinator <pubkey>]
available-kps [--coordinator <pubkey>]
create-group <alias> [keyPackageAlias] [--coordinator <pubkey>] [--name <value>] [--description <value>] [--icon <value>] [--image-url <value>] [--admin <hex>]... [--watch]
update-group-metadata <groupAlias> --name <value> [--description <value>] [--icon <value>] [--image-url <value>] [--admin <hex>]...
set-metadata <groupAlias> --name <value> [--description <value>] [--icon <value>] [--image-url <value>] [--admin <hex>]...
groups
group-info [groupAlias]
group <groupAlias> [--watch]
use <groupAlias> [--watch]
leave    (clear selection; does not change group membership)
unwatch <groupAlias>
add-member <groupAlias> <stablePubkeyOrKeyPackageRef>
remove-member <groupAlias> <stablePubkey>
fetch-welcomes [--coordinator <pubkey>]
welcomes
accept-welcome <welcomeIdOrKeyPackageReference> [groupAlias] [--coordinator <pubkey>] [--watch]
fetch-join-requests [groupAlias]
request-join <gid> [keyPackageAlias] [--coordinator <pubkey>]
send <message...>    (uses selected group)
send-to <groupAlias> <message...>
send-media <filePath> [caption...]   (uses selected group; requires --media-dir)
save-media [groupAlias] <cursor> [destDir]   (decrypts media to destDir, default .)
sync [groupAlias]
sync-all
watch-all
messages [groupAlias]
issues [groupAlias]
exit | quit
```

`groupAlias` is optional where shown only when a group is selected in the interactive REPL. One-shot commands do not retain selection; use explicit aliases and `send-to`.

## KeyPackages

`gen-kp` publishes immediately unless `--local-only` is supplied. Publish local-only material later with:

```text
publish-kp <alias> [--coordinator <pubkey>]
```

Regular KeyPackages support one invitation. `--last-resort` creates reusable invitation material.

## Groups and watches

`group` and `use` are aliases. `leave` only clears the local REPL selection; it does not remove the client from the MLS group. `--watch` performs catch-up before starting live delivery.

`group-info` prints the protocol group ID required by `request-join`.

## Startup commands

These run before session or network initialization and are not REPL commands:

```sh
cordn --help
cordn --version
cordn docs [quickstart|commands|agent|daemon|queues|security]
```
