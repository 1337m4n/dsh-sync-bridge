#!/usr/bin/env bash
# Publish this source tree as a PUBLIC GitHub repository in the signed-in user's account.
# The sync-data repository is separate and must remain PRIVATE.
set -euo pipefail
cd "$(dirname "$0")"
REPO_NAME="${1:-dsh-sync-bridge}"
if ! command -v gh >/dev/null 2>&1; then
  echo 'GitHub CLI is required: brew install gh (macOS) or https://cli.github.com/' >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo 'Sign in to GitHub in your browser:'
  gh auth login --web
fi
if [ ! -d .git ]; then
  git init -b main
fi
if git remote get-url origin >/dev/null 2>&1; then
  echo 'This directory already has an origin remote. Aborting to avoid publishing to the wrong repository.' >&2
  exit 1
fi
# Stage only reviewed source files: never add local credentials or runtime data.
git add .gitignore .github/workflows/test.yml README.md cli.mjs cordis.patch.yml core.js index.js package.json test.mjs publish-github.sh
if ! git diff --cached --quiet; then
  git commit -m 'Initial release: DSH Sync Bridge v0.1.0'
fi
gh repo create "$REPO_NAME" --public --source=. --remote=origin --push
echo 'GitHub project URL:'
gh repo view --json url --jq '.url'
