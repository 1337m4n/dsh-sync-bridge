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
ACCOUNT="$(gh api user --jq .login)"
echo "Publishing reviewed source to GitHub account: $ACCOUNT"
# Existing repositories are never repurposed, even when empty.
if gh repo view "$ACCOUNT/$REPO_NAME" >/dev/null 2>&1; then
  echo 'Destination repository already exists. Inspect it manually; refusing overwrite.' >&2
  exit 1
fi
npm test
if [ ! -d .git ]; then
  git init -b main
fi
if git remote get-url origin >/dev/null 2>&1; then
  echo 'This directory already has an origin remote. Aborting to avoid publishing to the wrong repository.' >&2
  exit 1
fi
# Stage only reviewed source files: never add local credentials or runtime data.
git add .gitignore .github/workflows/test.yml README.md cli.mjs cordis.patch.yml core.js index.js package.json test.mjs publish-github.sh
# Reject files staged by an earlier command and files anywhere in local history.
allowed='.gitignore .github/workflows/test.yml README.md cli.mjs cordis.patch.yml core.js index.js package.json test.mjs publish-github.sh'
while IFS= read -r file; do
  case " $allowed " in *" $file "*) ;; *) echo "Unreviewed tracked/history file: $file" >&2; exit 1 ;; esac
done < <({ git ls-files; git log --all --format= --name-only; } | sort -u | sed '/^$/d')
git diff --cached --check
if ! git diff --cached --quiet; then
  git commit -m 'Initial release: DSH Sync Bridge v0.1.0'
fi
gh repo create "$ACCOUNT/$REPO_NAME" --public --source=. --remote=origin --push
echo 'GitHub project URL:'
gh repo view --json url --jq '.url'
