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

ARG=${1:-}
if [ "${ARG}" = "--check" ] || [ "${ARG}" = "-c" ]; then
  check_gh
  USER_LOGIN=$(gh api user --jq .login)
  echo "GitHub CLI is installed and authenticated as: ${USER_LOGIN}"
  exit 0
fi

PR_ID=${ARG}

if [ -z "$PR_ID" ]; then
  echo "Usage: $0 <pr-id>"
  echo "       $0 <options>"
  echo
  echo "This will:"
  echo "1. Rebase the PR with its target branch, with each contained commit signed."
  echo "2. Create or update a temporary PR to allow running CI on the community PR."
  echo
  echo "Re-running with the same <pr-id> picks up any new commits on the source"
  echo "branch and force-pushes them onto the existing temporary branch and PR."
  echo
  echo "Options:"
  echo "  --check, -c        Verify GitHub CLI installation and authentication, then exit."
  echo
  echo "Prerequisites:"
  echo "- You must have a GPG key configured to use with git."
  echo "- You must have write access to the PR."
  echo "- You must have the GitHub CLI installed."
  echo
  exit 1
fi

check_gh

GITHUB_USER=$(gh api user --jq .login)
BASE_COMMIT=$(gh pr view $PR_ID --json baseRefOid --jq '.baseRefOid')
PR_BRANCH=$(gh pr view $PR_ID --json headRefName --jq '.headRefName')
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
    git worktree remove "$WORKTREE_DIR" 2>/dev/null || true
  fi
  if [ -n "${PR_BRANCH:-}" ]; then
    git branch -D "$PR_BRANCH" 2>/dev/null || true
  fi
}

trap cleanup EXIT ERR INT

git worktree add $WORKTREE_DIR
cd $WORKTREE_DIR

git fetch origin
gh pr checkout $PR_ID --repo DataDog/dd-trace-js --force
git rebase --gpg-sign $BASE_COMMIT
git push --force
git push --force origin HEAD:$TEMP_BRANCH

if [ -z "$EXISTING_TEMP_BRANCH" ]; then
  gh pr create \
    --repo DataDog/dd-trace-js \
    --head $TEMP_BRANCH \
    --draft \
    --label "semver-patch" \
    --title "Temp: Run CI on community PR #$PR_ID" \
    --body "This is a temporary PR to allow running CI on the community PR #$PR_ID. It should be closed after CI has completed running."
fi
gh pr view $TEMP_BRANCH --web --repo DataDog/dd-trace-js
