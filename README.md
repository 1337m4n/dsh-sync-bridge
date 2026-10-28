# DSH Sync Bridge v0.1.0 (Mac → Windows)

**Experimental**, not yet tested in the real DSH Desktop runtime. This is a source-to-target sync plugin, **not** a WeChat/DeepSeek account sync integration. Both computers independently authenticate to GitHub; no WeChat tokens are used or read.

## Scope

- Mac publishes and Windows subscribes to an end-to-end encrypted snapshot in **your own private GitHub repository**.
- Polls in the background while DSH Desktop is running; defaults to 90 seconds.
- Encrypted AES-256-GCM snapshots with scrypt-derived key; same passphrase on both ends.
- By default syncs `profiles/desktop/cordis.patch.yml` and files inside `$DSH_HOME/sync-bridge-assets/` with image/video/CSS/JSON extensions. This assets directory is **not** automatically used by third-party startup animation plugins; adjust their asset path to match. Individual assets limited to 3 MiB, total 8 MiB; the GitHub Git Blobs endpoint is used when the ordinary Contents API omits large inline content. Video files above the size cap need another transport.
- Optional `$DSH_HOME/cordis.patch.yml` sync (this may contain API keys, environment-specific settings, or private data; opt-in only).
- Reads only *dependency names and version specifiers* from the Desktop profile manifest; does **not** transport `package.json`, lockfiles, executable code, `node_modules`, credentials store, session history or browser storage.
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
3. Run the corresponding desktop bundled `dsh` CLI: `dsh plugin --profile desktop add ./dsh-sync-bridge-v0.1.0` (adjust path), then reopen DSH Desktop. On a Mac, a fully qualified local folder path also works.
4. From a Node 22+ terminal, run `node /path/to/dsh-sync-bridge-v0.1.0/cli.mjs init` on each machine. Use the **same GitHub repository, channel name and encryption passphrase**. Select `publisher` on the Mac and `subscriber` on Windows. Use different permission-scoped GitHub tokens if possible. Leave global patch and auto-apply opt-out initially.
5. Fully quit and reopen DSH on both systems after `init`, so the background plugin sees the new local configuration. On Mac run `node cli.mjs sync`, then on Windows `node cli.mjs sync`, then `node cli.mjs status`.
6. Fully quit Windows DSH before first import; inspect the `~/.dsh/sync-bridge/inbox.json` encrypted-in-transit but **decrypted on this machine**, then run `node cli.mjs apply --force` **only if** you want the Mac config to replace any existing, differing Windows config. Otherwise `apply` will report conflicts. Backups are placed under `~/.dsh/sync-bridge/backups/`.
7. Run `node cli.mjs show-desired-plugins` on Windows. Fully exit DSH Desktop, review and install only missing packages through the official plugin manager. Reopen DSH Desktop. For future updates the background plugin will keep polling, but new plugins still require the official installation step.

## Mac/Windows safety

The target paths are based on `$DSH_HOME`, falling back to `~/.dsh`. `~/.dsh/sync-bridge/local.json` stores the GitHub token and encryption passphrase **unencrypted on local disk**. Its Unix mode is 0600; Windows relies on the user's directory ACL. Keep this file private and exclude it from all other syncing and backups. The remote snapshot is encrypted, but local settings and backups are not; this is an experimental personal-use utility, not a credential vault.

Config snapshots may contain machine-specific path strings. If a path in the imported YAML points at `/Users/...` on Windows, adjust it to `C:\Users\...`. DSH HMR may reload configuration, but restart is recommended after applying settings; any native plugin installation requires exiting DSH Desktop.

**Limitations:** No in-app settings panel yet, no automatic dependency installation, no browser localStorage migration, no 2-way conflict merging, and no claim that a specific boot-animation plugin works without knowing its storage implementation. Do not deploy to important production data without reviewing the source and backups.

## Publishing this source on GitHub

This source code repository can be public; **keep your separate synchronization-data repository private**. Never commit `.dsh/sync-bridge/local.json`, repository access tokens, encryption passphrases, or actual synchronized private data.

On macOS, install [GitHub CLI](https://cli.github.com/) if needed (`brew install gh`), unzip the GitHub-ready source bundle, open its directory and run:

```bash
./publish-github.sh
```

The script signs in via `gh auth login --web` if needed, creates a **public** GitHub repository named `dsh-sync-bridge` in your currently authenticated GitHub account, pushes only the reviewed source files, and prints the real URL when successful. The script does not reuse your WeChat or DSH login. You may supply a different name as its first argument. If the repository name already exists, it stops rather than overwriting an existing repository.
