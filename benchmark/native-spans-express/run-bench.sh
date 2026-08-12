#!/usr/bin/env bash
#
# Wrapper for the native-spans Express benchmark.
#
# Sets up an installed candidate checkout and runs
# `benchmark/native-spans-express/run.js` against it with --candidate-dir, so
# the benchmark uses a stable, pre-installed candidate instead of creating a
# throwaway worktree and reinstalling it on every run.
#
# By default the candidate is installed with the RELEASE versions of
# @datadog/libdatadog / libdatadog (whatever the candidate ref's committed
# yarn.lock pins, i.e. the published npm package) — what you want for
# benchmarking.
#
# Usage:
#   benchmark/native-spans-express/run-bench.sh [--local] [bench args...]
#
#   --local   instead of the release package, rebuild the local
#             ../libdatadog-nodejs (which compiles ../libdatadog) and symlink
#             it into the candidate's node_modules.
#
#   All other args are forwarded to run.js, e.g. --smoke, --workload, etc.
#
# Env:
#   CANDIDATE_REF   git ref for the candidate (default: bengl/native-spans-attempt-3)
#   CANDIDATE_DIR   where to keep the candidate worktree (default: ../candidate-native-spans)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIBDATADOG_NODEJS="$ROOT/../libdatadog-nodejs"
CANDIDATE_REF="${CANDIDATE_REF:-bengl/native-spans-attempt-3}"
CANDIDATE_DIR="${CANDIDATE_DIR:-$(cd "$ROOT/.." && pwd)/candidate-native-spans}"

LOCAL=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --local) LOCAL=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

if ! git -C "$ROOT" rev-parse --verify "$CANDIDATE_REF^{commit}" >/dev/null 2>&1; then
  echo "error: git ref '$CANDIDATE_REF' not found in $ROOT" >&2
  exit 1
fi

# --- 1. candidate checkout --------------------------------------------------
if [ -d "$CANDIDATE_DIR" ]; then
  current="$(git -C "$CANDIDATE_DIR" rev-parse HEAD 2>/dev/null || true)"
  target="$(git -C "$ROOT" rev-parse "$CANDIDATE_REF^{commit}")"
  if [ "$current" != "$target" ]; then
    echo "refreshing candidate worktree ($current -> $target)"
    git -C "$ROOT" worktree remove --force "$CANDIDATE_DIR" 2>/dev/null \
      || rm -rf "$CANDIDATE_DIR"
    git -C "$ROOT" worktree add --detach "$CANDIDATE_DIR" "$CANDIDATE_REF"
  fi
else
  echo "creating candidate worktree at $CANDIDATE_DIR"
  git -C "$ROOT" worktree add --detach "$CANDIDATE_DIR" "$CANDIDATE_REF"
fi

# --- 2. install candidate with release versions ----------------------------
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
echo "installing candidate ($CANDIDATE_REF) with release deps..."
(cd "$CANDIDATE_DIR" && yarn install --frozen-lockfile --non-interactive)
if [ ! -d "$CANDIDATE_DIR/node_modules/@datadog/libdatadog" ]; then
  echo "release @datadog/libdatadog missing after install; forcing reinstall"
  (cd "$CANDIDATE_DIR" && yarn install --frozen-lockfile --non-interactive --force)
fi

# --- 3. optional: use local libdatadog-nodejs ------------------------------
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

# --- 4. run the benchmark ---------------------------------------------------
echo "running benchmark: candidate=$CANDIDATE_DIR ref=$CANDIDATE_REF local=$LOCAL"
exec node "$ROOT/benchmark/native-spans-express/run.js" --candidate-dir "$CANDIDATE_DIR" "${ARGS[@]}"
