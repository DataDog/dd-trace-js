#!/usr/bin/env bash
#
# Wrapper for the native-spans Express benchmark.
#
# Reinstalls a candidate checkout in place and runs
# `benchmark/native-spans-express/run.js` against it with --candidate-dir, so
# the benchmark uses a stable, pre-installed candidate instead of creating a
# throwaway worktree and reinstalling it on every run.
#
# The candidate's git ref is whatever is already checked out at
# --candidate-dir — manage worktrees/refs yourself (e.g. with separate
# gitrees), this script only (re)installs dependencies and runs the
# benchmark.
#
# By default the candidate is installed with the RELEASE versions of
# @datadog/libdatadog / libdatadog (whatever the candidate's committed
# yarn.lock pins, i.e. the published npm package) — what you want for
# benchmarking.
#
# Usage:
#   run-bench.sh --candidate-dir <path> [--local] [bench args...]
#
# Options:
#   --candidate-dir <path> Candidate checkout to install and benchmark (required)
#   --local                Instead of the release package, rebuild the local
#                           ../libdatadog-nodejs (which compiles ../libdatadog)
#                           and symlink it into the candidate's node_modules.
#
#   All other args are forwarded to run.js, e.g. --smoke, --workload, etc.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBDATADOG_NODEJS="$ROOT/../libdatadog-nodejs"

CANDIDATE_DIR=""
LOCAL=0
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --candidate-dir)
      CANDIDATE_DIR="${2:?--candidate-dir requires a value}"
      shift 2
      ;;
    --local)
      LOCAL=1
      shift
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if [ -z "$CANDIDATE_DIR" ]; then
  echo "error: --candidate-dir <path> is required" >&2
  exit 1
fi
if [ ! -d "$CANDIDATE_DIR" ]; then
  echo "error: candidate directory not found: $CANDIDATE_DIR" >&2
  exit 1
fi
CANDIDATE_DIR="$(cd "$CANDIDATE_DIR" && pwd)"

# --- 1. install candidate with release versions ----------------------------
# Restore committed manifests (in case a previous --local run touched them) and
# drop any local symlink so yarn re-installs the release package.
git -C "$CANDIDATE_DIR" checkout -- package.json yarn.lock 2>/dev/null || true
if [ -L "$CANDIDATE_DIR/node_modules/@datadog/libdatadog" ]; then
  rm "$CANDIDATE_DIR/node_modules/@datadog/libdatadog"
fi
# yarn 1.x does not re-add a manually-removed *optional* dependency on an
# incremental install (it treats it as already-resolved), so drop the integrity
# file to force yarn to re-resolve the full tree from the lockfile. This is
# what guarantees the release @datadog/libdatadog comes back after a --local run.
rm -f "$CANDIDATE_DIR/node_modules/.yarn-integrity"
echo "installing candidate ($CANDIDATE_DIR) with release deps..."
(cd "$CANDIDATE_DIR" && yarn install --frozen-lockfile --non-interactive)
if [ ! -d "$CANDIDATE_DIR/node_modules/@datadog/libdatadog" ]; then
  echo "release @datadog/libdatadog missing after install; forcing reinstall"
  (cd "$CANDIDATE_DIR" && yarn install --frozen-lockfile --non-interactive --force)
fi

# --- 2. optional: use local libdatadog-nodejs ------------------------------
if [ "$LOCAL" = 1 ]; then
  if [ ! -d "$LIBDATADOG_NODEJS" ]; then
    echo "error: local libdatadog-nodejs not found at $LIBDATADOG_NODEJS" >&2
    exit 1
  fi
  echo "rebuilding local libdatadog-nodejs ($LIBDATADOG_NODEJS)"
  (cd "$LIBDATADOG_NODEJS" && yarn build)
  rm -rf "$CANDIDATE_DIR/node_modules/@datadog/libdatadog"
  ln -s "$LIBDATADOG_NODEJS" "$CANDIDATE_DIR/node_modules/@datadog/libdatadog"
  echo "linked local libdatadog-nodejs into candidate"
fi

# --- 3. run the benchmark ---------------------------------------------------
echo "running benchmark: candidate=$CANDIDATE_DIR local=$LOCAL"
exec node "$ROOT/benchmark/native-spans-express/run.js" --candidate-dir "$CANDIDATE_DIR" "${ARGS[@]}"
