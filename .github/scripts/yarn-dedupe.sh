#!/usr/bin/env bash

set -ex

if git diff --exit-code yarn.lock; then
  echo "✅ yarn.lock is already properly deduplicated"
else
  echo "📝 yarn.lock was modified by dedupe command"

  PR_AUTHOR="${PR_AUTHOR:-}"
  PR_USER_TYPE="${PR_USER_TYPE:-}"
  IS_BOT=false

  if [[ "$PR_USER_TYPE" == "Bot" ]] || [[ "$PR_AUTHOR" == *"bot"* ]] || [[ "$PR_AUTHOR" == "renovate"* ]] || [[ "$PR_AUTHOR" == "github-actions"* ]]; then
    IS_BOT=true
  fi

  if [[ "$IS_BOT" == "true" ]] && [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" ]]; then
    echo "🤖 Bot-created PR detected. Auto-committing yarn.lock changes..."

    git config --local user.email "action@github.com"
    git config --local user.name "GitHub Action"

    git add yarn.lock
    git commit -m "Auto-dedupe yarn.lock dependencies"

    git push origin HEAD:${GITHUB_HEAD_REF}

    echo "✅ Successfully committed and pushed yarn.lock deduplication"
  else
    echo "❌ The yarn.lock file needs deduplication!"
    echo ""
    echo "The yarn dedupe command has modified your yarn.lock file."
    echo "This means there were duplicate dependencies that could be optimized."
    echo ""
    echo "To fix this issue:"
    echo "1. Run 'yarn dependencies:dedupe' locally"
    echo "2. Commit the updated yarn.lock file"
    echo "3. Push your changes"
    echo ""
    echo "This helps keep the dependency tree clean."
    exit 1
  fi
fi
