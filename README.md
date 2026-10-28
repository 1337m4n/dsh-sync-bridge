# DSH Sync Bridge v0.1.0 (Mac → Windows)

**Experimental**: isolated lifecycle/profile checks use the installed DSH Desktop 0.2.1-rc.3 modules; real Mac/Windows Desktop synchronization has not been tested. This is a source-to-target sync plugin, **not** a WeChat/DeepSeek account sync integration. Both computers independently authenticate to GitHub; no WeChat tokens are used or read.

## Local credential warning

**`cli.mjs init` currently echoes the token and encryption passphrase in the terminal and stores both unencrypted in `$DSH_HOME/sync-bridge/local.json`.** Unix mode is 0600; Windows relies on the user's directory ACL. Snapshots are encrypted in transit and at rest on GitHub, but local inboxes, settings and backups are plaintext. This is not a credential vault. Use a private terminal and exclude runtime data from public repositories and shared backups.

## Scope

- Mac publishes and Windows subscribes to an end-to-end encrypted snapshot in **your own private GitHub repository**.
- Polls in the background while DSH Desktop is running; defaults to 90 seconds.
- Encrypted AES-256-GCM snapshots with scrypt-derived key; same passphrase on both ends.
- By default syncs `profiles/desktop/cordis.patch.yml` and files inside `$DSH_HOME/sync-bridge-assets/` with image/video/CSS/JSON extensions. This assets directory is **not** automatically used by third-party startup animation plugins; adjust their asset path to match. Individual assets limited to 3 MiB, total 8 MiB and 512 files; the GitHub Git Blobs endpoint is used when the ordinary Contents API omits large inline content. Video files above the size cap need another transport.
- Optional `$DSH_HOME/cordis.patch.yml` sync (this may contain API keys, environment-specific settings, or private data; opt-in only).
- Reads only registry *dependency names and version specifiers* (local paths, Git URLs and URL credentials are omitted) from the Desktop profile manifest; does **not** transport `package.json`, lockfiles, executable code, `node_modules`, credentials store, session history or browser storage.
- Before each sync, GitHub repository metadata must confirm the runtime repository is private. HTTP requests time out after 30 seconds; rate limits enter a cooldown.
- The Windows subscriber stages new data; first application needs approval, and overwrites of existing files are conflict-protected. Backups are kept before changes.
- The **plugin manifest is advisory**: installing or upgrading plugins must be performed via official DSH Desktop plugin management after the application has fully quit. The bridge never changes package dependencies while the application runs.
- This is **not** live bidirectional editing. Version 0.1 supports Mac → Windows only.

## Requirements

- Same supported DSH release family on both computers; official desktop builds use `desktop` profile, some community wrappers use `web` or another profile (unsupported by this bundle as shipped).
- Node.js >= 22 for the CLI (DSH Desktop may bundle a Node shim; otherwise install Node.js separately).
- A private GitHub repository created by you. Use a **fine-grained GitHub token** limited to this one repo, Contents read/write. For better isolation, grant the Windows device read-only repository access; its role only needs GET.
- A long, randomly generated passphrase shared privately between Mac and Windows. Keep the token and passphrase out of shell history and screenshots.
- Do not synchronize `.dsh` wholesale: OS binaries, auth state, native plugins and database locks are incompatible.

## Install on *both* computers

1. Extract this directory locally.
2. Quit DSH Desktop completely before installing plugins.
3. Run the corresponding desktop bundled `dsh` CLI: `dsh plugin --profile desktop add ./dsh-sync-bridge` (for a Git clone); the handoff ZIP extracts as `dsh-sync-bridge-github`, so use `./dsh-sync-bridge-github` for that archive, then reopen DSH Desktop. On a Mac, a fully qualified local folder path also works.
4. From a Node 22+ terminal, run `node /path/to/dsh-sync-bridge/cli.mjs init` on each machine. Use the **same GitHub repository, channel name and encryption passphrase**. Select `publisher` on the Mac and `subscriber` on Windows. Use different permission-scoped GitHub tokens if possible. Leave global patch and auto-apply opt-out initially.
5. Fully quit and reopen DSH on both systems after `init`, so the background plugin sees the new local configuration. On Mac run `node cli.mjs sync`, then on Windows `node cli.mjs sync`, then `node cli.mjs status`.
6. Fully quit Windows DSH before importing settings; inspect the `~/.dsh/sync-bridge/inbox.json` encrypted-in-transit but **decrypted on this machine**, then run `node cli.mjs apply --force` **only if** you want the Mac config to replace any existing, differing Windows config. Otherwise `apply` will report conflicts. `--force` explicitly resolves later conflicts too; automatic sync never forces overwrites. Backups are placed under `~/.dsh/sync-bridge/backups/`.
7. Run `node cli.mjs show-desired-plugins` on Windows. Fully exit DSH Desktop, review and install only missing packages through the official plugin manager. Reopen DSH Desktop. For future updates the background plugin will keep polling, but new plugins still require the official installation step.

## Mac/Windows safety

The installed macOS Desktop 0.2.1-rc.3 CLI supports `dsh plugin --profile desktop add <local-directory>`. Use its bundled launcher at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` if `dsh` on PATH points to another installation. Desktop must have been opened once to initialize its profile, then fully exited before plugin installation. The package's Cordis insert and `ctx.effect` cleanup are checked with installed rc.3 modules in a temporary home; this is not a real Desktop/Mac-to-Windows sync test. Other 0.2.x releases are declared compatible but are not all verified.

The target paths are based on `$DSH_HOME`, falling back to `~/.dsh`. `~/.dsh/sync-bridge/local.json` stores the GitHub token and encryption passphrase **unencrypted on local disk**. Its Unix mode is 0600; Windows relies on the user's directory ACL. Keep this file private and exclude it from all other syncing and backups. The remote snapshot is encrypted, but local settings and backups are not; this is an experimental personal-use utility, not a credential vault.

**Both profile and global YAML patches may contain credentials, private settings, shell commands or machine-specific paths.** The bridge copies approved files verbatim; it does not parse or redact their contents. Review these files and trust the publisher before enabling sync or automatic application. A private repository plus encryption does not make untrusted settings safe.

Config snapshots may contain machine-specific path strings. If a path in the imported YAML points at `/Users/...` on Windows, adjust it to `C:\Users\...`. DSH HMR may reload configuration, but restart is recommended after applying settings; any native plugin installation requires exiting DSH Desktop.

**Limitations:** No in-app settings panel yet, no automatic dependency installation, no browser localStorage migration, no 2-way conflict merging, and no claim that a specific boot-animation plugin works without knowing its storage implementation. Do not deploy to important production data without reviewing the source and backups.

## Verification

Run `npm test` on Node 22 or newer. Tests use temporary mock profiles, in-memory encrypted transport and mocked GitHub HTTP responses; no real user settings or tokens are used. CI runs this suite on macOS, Windows and Linux with Node 22 and 24. It covers large-file Blob routing, private-repository enforcement, HTTP errors/rate limits, snapshot validation and limits, symlink/path safety, conflict backups, interrupted application recovery and tampered ciphertext. Real GitHub runtime snapshot transfer, DSH UI reloads and cross-device syncing remain unverified.

Changing the repository, channel, role, encryption passphrase or global-patch scope resets first-import approval. An inbox from another configuration must be downloaded again. Invalid JSON state fails closed; restore the local state/config from your own backup rather than deleting it blindly. Backups grow until the owner reviews/removes them; this version does not prune them or delete target files missing from later snapshots. Run only one bridge process per home (stop Desktop background sync before manual CLI writes); v0.1 has no cross-process lock or multi-file transaction. Symlink checks do not protect against a hostile local process racing filesystem changes.

## Publishing this source on GitHub

This source code repository can be public; **keep your separate synchronization-data repository private**. Never commit `.dsh/sync-bridge/local.json`, repository access tokens, encryption passphrases, or actual synchronized private data.

On macOS, install [GitHub CLI](https://cli.github.com/) if needed (`brew install gh`), unzip the GitHub-ready source bundle, open its directory and run:

```bash
./publish-github.sh
```

The script signs in via `gh auth login --web` if needed, creates a **public** GitHub repository named `dsh-sync-bridge` in your currently authenticated GitHub account, runs tests, rejects unexpected staged/tracked files, pushes only the reviewed source files, and prints the real URL when successful. The script does not reuse your WeChat or DSH login. You may supply a different name as its first argument. If the repository name already exists, it stops rather than overwriting an existing repository.
