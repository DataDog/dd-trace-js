#!/usr/bin/env bash

set -euo pipefail

check_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "Error: GitHub CLI 'gh' is not installed. Install from https://cli.github.com and run 'gh auth login'."
    exit 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "Error: GitHub CLI 'gh' is not authenticated. Run 'gh auth login' and ensure you can access the repository."
    exit 1
  fi
  if ! gh api user >/dev/null 2>&1; then
    echo "Error: 'gh' cannot access the GitHub API. Check your network or authentication."
    exit 1
  fi
}

PR_ID=
SIGN_COMMITS=false
for ARG in "$@"; do
  case "$ARG" in
    --sign)
      SIGN_COMMITS=true
      ;;
    --check|-c)
      check_gh
      USER_LOGIN=$(gh api user --jq .login)
      echo "GitHub CLI is installed and authenticated as: ${USER_LOGIN}"
      exit 0
      ;;
    -*)
      echo "Error: Unknown option '$ARG'." >&2
      exit 1
      ;;
    *)
      if [ -n "$PR_ID" ]; then
        echo "Error: Specify only one PR ID." >&2
        exit 1
      fi
      PR_ID=$ARG
      ;;
  esac
done

if [ -z "$PR_ID" ]; then
  echo "Usage: $0 <pr-id> [--sign]"
  echo "       $0 <options>"
  echo
  echo "This will:"
  echo "Create or update a temporary PR to allow running CI on the community PR."
  echo "By default, the temporary branch preserves the original commit hashes."
  echo
  echo "Re-running with the same <pr-id> picks up any new commits on the source"
  echo "branch and force-pushes them onto the existing temporary branch and PR."
  echo
  echo "Options:"
  echo "  --sign             Rebase onto the target branch and sign every commit. This changes commit hashes."
  echo "  --check, -c        Verify GitHub CLI installation and authentication, then exit."
  echo
  echo "Prerequisites:"
  echo "- You must have a Git signing key configured when using --sign."
  echo "- You must have write access to DataDog/dd-trace-js."
  echo "- You must have the GitHub CLI installed."
  echo
  exit 1
fi

check_gh

GITHUB_USER=$(gh api user --jq .login)
TEMP_BRANCH_PREFIX=$GITHUB_USER/tmp-ci-run-$PR_ID-

EXISTING_TEMP_BRANCH=$(gh pr list \
  --repo DataDog/dd-trace-js \
  --state open \
  --author "@me" \
  --json headRefName \
  --jq ".[] | select(.headRefName | startswith(\"$TEMP_BRANCH_PREFIX\")) | .headRefName" \
  | head -n1)

if [ -n "$EXISTING_TEMP_BRANCH" ]; then
  TEMP_BRANCH=$EXISTING_TEMP_BRANCH
  echo "Updating existing temporary branch from a previous run: $TEMP_BRANCH"
else
  TEMP_BRANCH=${TEMP_BRANCH_PREFIX}$(date +%s)
fi

WORKTREE_DIR=$(mktemp -d)
ORIGINAL_DIR=$(pwd)

cleanup() {
  if [ -n "${WORKTREE_DIR:-}" ] && [ -d "$WORKTREE_DIR" ]; then
    cd "$ORIGINAL_DIR" 2>/dev/null || true
    git worktree remove --force "$WORKTREE_DIR"
  fi
}

trap cleanup EXIT ERR INT

git worktree add --detach "$WORKTREE_DIR"
cd "$WORKTREE_DIR"

git fetch origin
TEMP_BRANCH_OID=$(git ls-remote origin "refs/heads/$TEMP_BRANCH" | cut -f1)
gh pr checkout "$PR_ID" --repo DataDog/dd-trace-js --force --detach
if [ "$SIGN_COMMITS" = true ]; then
  BASE_COMMIT=$(gh pr view "$PR_ID" --repo DataDog/dd-trace-js --json baseRefOid --jq '.baseRefOid')
  git rebase --force-rebase --gpg-sign "$BASE_COMMIT"
fi
git push --force-with-lease="refs/heads/$TEMP_BRANCH:$TEMP_BRANCH_OID" \
  origin "HEAD:refs/heads/$TEMP_BRANCH"

if [ -z "$EXISTING_TEMP_BRANCH" ]; then
  gh pr create \
    --repo DataDog/dd-trace-js \
    --head "$TEMP_BRANCH" \
    --draft \
    --label "semver-patch" \
    --title "chore: run CI on community PR #$PR_ID" \
    --body "This is a temporary PR to allow running CI on the community PR #$PR_ID. It should be closed after CI has completed running."
fi
gh pr view "$TEMP_BRANCH" --web --repo DataDog/dd-trace-js
