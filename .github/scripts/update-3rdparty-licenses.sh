#!/usr/bin/env bash

set -e

if git diff --ignore-space-at-eol --exit-code LICENSE-3rdparty.csv; then
  echo "✅ LICENSE-3rdparty.csv is already up to date"
else
  echo "📝 LICENSE-3rdparty.csv was modified by license attribution command"

  PR_AUTHOR="${PR_AUTHOR:-}"
  PR_USER_TYPE="${PR_USER_TYPE:-}"

  if [[ "$PR_USER_TYPE" == "Bot" ]] && [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" ]]; then
    echo "🤖 Bot-created PR detected. Auto-committing LICENSE-3rdparty.csv changes..."

    git config --local user.email "action@github.com"
    git config --local user.name "GitHub Action"

    git add LICENSE-3rdparty.csv
    git commit -m "Update LICENSE-3rdparty.csv"

    git push origin HEAD:${GITHUB_HEAD_REF}

    echo "✅ Successfully committed and pushed LICENSE-3rdparty.csv updates"
  else
    echo "❌ The LICENSE-3rdparty.csv file needs to be updated!"
    echo ""
    echo "The license attribution command has modified LICENSE-3rdparty.csv."
    echo ""
    echo "To fix this issue:"
    echo "1. Set up dd-license-attribution locally by following the installation instructions in:"
    echo "   https://github.com/DataDog/dd-license-attribution"
    echo "2. Run the license CSV generation command locally:"
    echo "   dd-license-attribution generate-sbom-csv \\"
    echo "     --no-scancode-strategy \\"
    echo "     --no-github-sbom-strategy \\"
    echo "     https://github.com/datadog/dd-trace-js > LICENSE-3rdparty.csv"
    echo "3. Append vendored dependencies:"
    echo "   cat .github/vendored-dependencies.csv >> LICENSE-3rdparty.csv"
    echo "4. Commit the updated LICENSE-3rdparty.csv file"
    echo "5. Push your changes"
    echo ""
    echo "This helps keep the 3rd-party license information accurate."
    exit 1
  fi
fi
