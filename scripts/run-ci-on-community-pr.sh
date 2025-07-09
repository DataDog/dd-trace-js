#!/usr/bin/env bash

set -euo pipefail

PR_ID=${1:-}

if [ -z "$PR_ID" ]; then
  echo "Usage: $0 <pr-id>"
  echo
  echo "This will:"
  echo "1. Rebase the PR with its target branch, with each contained commit signed."
  echo "2. Create a temporary PR to allow running CI on the community PR."
  echo
  echo "Prerequisites:"
  echo "- You must have a GPG key configured to use with git."
  echo "- You must have write access to the PR."
  echo
  exit 1
fi

GITHUB_USER=$(gh api user --jq .login)
BASE_COMMIT=$(gh pr view $PR_ID --json baseRefOid --jq '.baseRefOid')
TEMP_BRANCH=$GITHUB_USER/tmp-ci-run-$PR_ID-$(date +%s)
WORKTREE_DIR=$(mktemp -d)
ORIGINAL_DIR=$(pwd)

cleanup() {
  if [ -n "${WORKTREE_DIR:-}" ] && [ -d "$WORKTREE_DIR" ]; then
    cd "$ORIGINAL_DIR" 2>/dev/null || true
    git worktree remove "$WORKTREE_DIR" 2>/dev/null || true
  fi
}

trap cleanup EXIT ERR INT

git worktree add $WORKTREE_DIR
cd $WORKTREE_DIR

git fetch origin
gh pr checkout $PR_ID
git rebase --gpg-sign $BASE_COMMIT
git push --force
git push origin HEAD:$TEMP_BRANCH

gh pr create \
  --head $TEMP_BRANCH \
  --draft \
  --label "semver-patch" \
  --title "Temp: Run CI on community PR #$PR_ID" \
  --body "This is a temporary PR to allow running CI on the community PR #$PR_ID. It should be closed after CI has completed running."
gh pr view $TEMP_BRANCH --web
