#!/bin/bash

set -e

DIRS=($(ls -d */ | sed 's:/$::')) # Array of subdirectories
CWD=$(pwd)

# Background subshells can't share a bash variable, so failed variants
# write their dir/variant name here and the parent counts lines after `wait`.
FAILURES_FILE=$(mktemp)
# Variants whose latest definition failed against the older baseline source;
# tolerated there unless this PR also changes non-benchmark source (see below).
SKIPPED_FILE=$(mktemp)

function cleanup {
  for D in "${DIRS[@]}"; do
    rm -f "${CWD}/${D}/meta-temp.json"
  done
  rm -f "$FAILURES_FILE" "$SKIPPED_FILE"
}

trap cleanup EXIT

# Install the pinned sirun unless the image already baked this exact version.
# The benchmarking-platform image records what it baked in /opt/baked-sirun-version;
# a mismatch means .sirun-version was bumped since the last image build, so fetch it
# here until the image catches up.
read -r SIRUN_VERSION SIRUN_SHA256 < "${CWD}/.sirun-version"
if [[ "$(cat /opt/baked-sirun-version 2>/dev/null)" != "${SIRUN_VERSION}" ]]; then
  wget -O sirun.tar.gz "https://github.com/DataDog/sirun/releases/download/v${SIRUN_VERSION}/sirun-v${SIRUN_VERSION}-x86_64-unknown-linux-musl.tar.gz"
  echo "${SIRUN_SHA256}  sirun.tar.gz" | sha256sum -c -
  tar -xzf sirun.tar.gz
  rm sirun.tar.gz
  mv sirun /usr/bin/sirun
fi

if test -f ~/.nvm/nvm.sh; then
  source ~/.nvm/nvm.sh
else
  source /usr/local/nvm/nvm.sh
fi

(
  cd ../../ &&
  npm install --global yarn || (sleep 60 && npm install --global yarn) \
    && yarn install --ignore-engines || (sleep 60 && yarn install --ignore-engines) \
    && PLUGINS="graphql|express" yarn services
)

(
  cd "${CWD}/startup/everything-fixture" &&
  npm ci --no-audit --no-fund || (sleep 60 && npm ci --no-audit --no-fund)
)

# run each test in parallel for a given version of Node.js
# once all of the tests have complete move on to the next version

TOTAL_CPU_CORES=$(nproc 2>/dev/null || echo "24")
# Derive cpuset start from the kernel when CPU_START_ID is not provided
if [[ -z "${CPU_START_ID}" ]]; then
  CPUSET_START=$(grep -oP 'Cpus_allowed_list:\s*\K\d+' /proc/self/status 2>/dev/null || echo "0")
else
  CPUSET_START="${CPU_START_ID}"
fi
export CPU_AFFINITY="${CPUSET_START}"

echo "CPU diagnostics:"
echo "  nproc: ${TOTAL_CPU_CORES}"
echo "  CPU_START_ID: ${CPU_START_ID:-<unset>}"
echo "  CPUSET_START: ${CPUSET_START}"
echo "  CPU_AFFINITY start: ${CPU_AFFINITY}"
echo "  cpuset: $(cat /proc/self/status 2>/dev/null | grep Cpus_allowed_list || echo 'N/A')"

# MAJOR_VERSION is provided by each benchmark stage. The exact patch is pinned once
# in the plugin versions manifest (node-<major>); read it so a Node bump there is the
# single change that moves the benchmark runtime.
NODE_VERSION=$(sed -n "s/.*\"node-${MAJOR_VERSION}\": *\"npm:node@\([0-9.]*\)\".*/\1/p" \
  "${CWD}/../../packages/dd-trace/test/plugins/versions/package.json")
if [[ -z "${NODE_VERSION}" ]]; then
  echo "No node-${MAJOR_VERSION} pin in packages/dd-trace/test/plugins/versions/package.json" >&2
  exit 1
fi
nvm install "${NODE_VERSION}"
export VERSION=`nvm current`
export ENABLE_AFFINITY=true
echo "using Node.js ${VERSION}"
CPU_AFFINITY="${CPUSET_START}" # reset for each node.js version
SPLITS=${SPLITS:-1}
GROUP=${GROUP:-1}

# With BENCHMARKS_FROM=candidate the baseline runs this PR's benchmark code on
# the older source. Skip a baseline failure only when the same variant passed on
# the candidate run -- proof the failure is specific to the older source, not a
# broken benchmark. The candidate run records its passing variants below.
SKIP_BASELINE_FAILURES=""
RECORD_CANDIDATE_PASS=""
CANDIDATE_PASSED_FILE="${ARTIFACTS_DIR:-/tmp}/candidate-passed-variants.txt"
if [[ "${TOLERATE_NEW_BENCHMARK_FAILURES:-}" == "1" ]]; then
  if [[ "${BASELINE_OR_CANDIDATE:-}" == "candidate" ]]; then
    RECORD_CANDIDATE_PASS="1"
    : > "$CANDIDATE_PASSED_FILE"
  elif [[ "${BASELINE_OR_CANDIDATE:-}" == "baseline" ]]; then
    SKIP_BASELINE_FAILURES="1"
  fi
fi

BENCH_COUNT=0
for D in "${DIRS[@]}"; do
  cd "${D}"
  variants="$(node ../get-variants.js)"
  for V in $variants; do BENCH_COUNT=$(($BENCH_COUNT+1)); done
  cd ..
done

# Auto-shard from the variant count and available cores: each shard pins one variant
# per core, so the suite needs ceil(BENCH_COUNT / cores) shards. The CI matrix supplies
# SPLITS shards; fail with the exact number to configure rather than silently dropping
# variants once the suite outgrows the matrix.
SHARDS_NEEDED=$(( (BENCH_COUNT + TOTAL_CPU_CORES - 1) / TOTAL_CPU_CORES ))
if [[ ${SPLITS} -lt ${SHARDS_NEEDED} ]]; then
  echo "${BENCH_COUNT} variants on ${TOTAL_CPU_CORES} cores need ${SHARDS_NEEDED} shards, but SPLITS=${SPLITS}." >&2
  echo "Set SPLITS and the GROUP rows per MAJOR_VERSION in .gitlab/benchmarks/gitlab-ci.yml to ${SHARDS_NEEDED}." >&2
  exit 1
fi

# Balance variants evenly across all configured shards; guaranteed <= cores each by the check above.
GROUP_SIZE=$(($(($BENCH_COUNT+$SPLITS-1))/$SPLITS)) # round up

BENCH_INDEX=0
BENCH_END=$(($GROUP_SIZE*$GROUP))
BENCH_START=$(($BENCH_END-$GROUP_SIZE))

for D in "${DIRS[@]}"; do
  cd "${D}"
  variants="$(node ../get-variants.js)"

  node ../squash-affinity.js

  for V in $variants; do
    if [[ ${BENCH_INDEX} -ge ${BENCH_START} && ${BENCH_INDEX} -lt ${BENCH_END} ]]; then
      echo "running $((BENCH_INDEX+1)) out of ${BENCH_COUNT}, ${D}/${V} in background, pinned to core ${CPU_AFFINITY}..."

      export SIRUN_VARIANT=$V

      (
        if time node ../run-one-variant.js >> ../results.ndjson; then
          echo "${D}/${V} finished."
          if [[ -n "${RECORD_CANDIDATE_PASS}" ]]; then echo "${D}/${V}" >> "$CANDIDATE_PASSED_FILE"; fi
        elif [[ -n "${SKIP_BASELINE_FAILURES}" ]] && grep -Fqx "${D}/${V}" "$CANDIDATE_PASSED_FILE" 2>/dev/null; then
          echo "${D}/${V} skipped: passed on the candidate but failed on the older baseline source." >&2
          # Append-only writes to a single tempfile from parallel subshells are
          # atomic on Linux below PIPE_BUF (4 KiB); each line here is ~30 bytes.
          echo "${D}/${V}" >> "$SKIPPED_FILE"
        else
          echo "${D}/${V} FAILED on core ${CPU_AFFINITY}" >&2
          echo "${D}/${V}" >> "$FAILURES_FILE"
        fi
      ) &
      ((CPU_AFFINITY=CPU_AFFINITY+1))
    fi

    BENCH_INDEX=$(($BENCH_INDEX+1))
  done

  cd ..
done

wait # waits until all tests are complete before continuing

node ./strip-unwanted-results.js

if [ "$DEBUG_RESULTS" == "true" ]; then
  echo "Benchmark Results:"
  cat ./results.ndjson
fi

echo "all tests for ${VERSION} have now completed."

FAILED_COUNT=$(wc -l < "$FAILURES_FILE" | tr -d ' ')
if [[ "${FAILED_COUNT}" -gt 0 ]]; then
  echo "" >&2
  echo "${FAILED_COUNT} variant(s) failed:" >&2
  sed 's/^/  - /' "$FAILURES_FILE" >&2
  exit 1
fi

SKIPPED_COUNT=$(wc -l < "$SKIPPED_FILE" | tr -d ' ')
if [[ "${SKIPPED_COUNT}" -gt 0 ]]; then
  echo "" >&2
  echo "${SKIPPED_COUNT} benchmark variant(s) failed on the baseline source and were skipped:" >&2
  sed 's/^/  - /' "$SKIPPED_FILE" >&2

  # A benchmark-only change is fine -- the skipped benchmark is the work. Any other
  # source change leaves the A/B comparison incomplete, so fail and ask for the
  # benchmark to land on its own first. Docs, CODEOWNERS, CI config and tests do
  # not count as source here.
  NON_BENCH_SOURCE_CHANGED=""
  if [[ -d /app/candidate/.git && -n "${COMMIT_SHA:-}" && -n "${CI_COMMIT_SHA:-}" ]]; then
    NON_BENCH_SOURCE_CHANGED="$(git -C /app/candidate diff --name-only "${COMMIT_SHA}..${CI_COMMIT_SHA}" \
      | grep -vE '(^benchmark/|^docs/|^\.github/|^\.gitlab/|\.md$|(^|/)CODEOWNERS$|^test/|/test/|/__tests__/|\.spec\.[jt]s$|\.test\.[jt]s$)' || true)"
  fi

  if [[ -n "${NON_BENCH_SOURCE_CHANGED}" ]]; then
    echo "" >&2
    echo "This PR also changes non-benchmark source, so the A/B comparison is incomplete." >&2
    echo "Land the benchmark change separately first, then rebase. Changed source files:" >&2
    echo "${NON_BENCH_SOURCE_CHANGED}" | sed 's/^/  - /' >&2
    exit 1
  fi
fi
