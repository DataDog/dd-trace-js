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
# In /tmp, not ARTIFACTS_DIR: analyze_microbenchmarks ingests that dir as sirun
# results and fails on this plain-text list; /tmp survives both runs.
CANDIDATE_PASSED_FILE="/tmp/candidate-passed-variants.txt"
if [[ "${TOLERATE_NEW_BENCHMARK_FAILURES:-}" == "1" ]]; then
  if [[ "${BASELINE_OR_CANDIDATE:-}" == "candidate" ]]; then
    RECORD_CANDIDATE_PASS="1"
    : > "$CANDIDATE_PASSED_FILE"
  elif [[ "${BASELINE_OR_CANDIDATE:-}" == "baseline" ]]; then
    SKIP_BASELINE_FAILURES="1"
  fi
fi

# async_hooks measures the Node async-hooks primitive floor, not tracer code, so it
# only moves when the Node version changes. Skip it unless this PR's diff touches a
# node-<major> pin in the versions manifest runall reads above (the single source of
# truth for the benchmarked Node patch). Fail open -- run it -- when the diff can't be
# determined, so a Node bump is never silently skipped.
RUN_ASYNC_HOOKS="1"
if [[ -d /app/candidate/.git && -n "${COMMIT_SHA:-}" && -n "${CI_COMMIT_SHA:-}" ]]; then
  # Capture the diff and its status separately rather than piping straight into
  # grep: a pipeline reports only grep's exit code, so a failed diff (shallow
  # checkout, stale COMMIT_SHA, missing range) would look like "no match" and
  # silently skip async_hooks -- the opposite of failing open. Only skip when the
  # diff actually succeeds and shows no node-<major> pin change.
  ASYNC_HOOKS_DIFF=""
  if ASYNC_HOOKS_DIFF=$(git -C /app/candidate diff "${COMMIT_SHA}..${CI_COMMIT_SHA}" -- \
      packages/dd-trace/test/plugins/versions/package.json 2>/dev/null); then
    if grep -qE '^[-+][[:space:]]*"node-[0-9]+":' <<< "${ASYNC_HOOKS_DIFF}"; then
      echo "async_hooks: a node-<major> pin changed in this diff; running it."
    else
      RUN_ASYNC_HOOKS=""
      echo "async_hooks: no Node version change in this diff; skipping (Node-primitive floor)."
    fi
  else
    echo "async_hooks: could not determine the diff; running it (fail open)."
  fi
fi

# Run a variant from the suite root. Background calls get their own shell and
# affinity variables, while all result and failure files remain append-only.
function run_variant {
  local D=$1
  local V=$2
  local CPU_COUNT=$3
  local CORE=$4
  local POSITION=$5
  local CPU_AFFINITY=$CORE
  local CPU_AFFINITY_SECOND=$((CORE+1))
  local CPU_DESCRIPTION
  local VARIANT_OUT

  export CPU_AFFINITY CPU_AFFINITY_SECOND
  export SIRUN_VARIANT=$V

  if [[ ${CPU_COUNT} -eq 1 ]]; then
    CPU_DESCRIPTION="core ${CPU_AFFINITY}"
  else
    CPU_DESCRIPTION="cores ${CPU_AFFINITY},${CPU_AFFINITY_SECOND}"
  fi
  echo "running ${POSITION}, ${D}/${V} in background, pinned to ${CPU_DESCRIPTION}..."

  cd "${D}"
  VARIANT_OUT=$(mktemp)
  if time node ../run-one-variant.js >> ../results.ndjson 2>"${VARIANT_OUT}"; then
    echo "${D}/${V} finished."
    if [[ -n "${RECORD_CANDIDATE_PASS}" ]]; then echo "${D}/${V}" >> "$CANDIDATE_PASSED_FILE"; fi
  elif [[ -n "${SKIP_BASELINE_FAILURES}" ]] \
      && grep -Fqx "${D}/${V}" "$CANDIDATE_PASSED_FILE" 2>/dev/null; then
    echo "${D}/${V} skipped: passed on the candidate but failed on the older baseline source." >&2
    # Append-only writes to a single tempfile from parallel subshells are
    # atomic on Linux below PIPE_BUF (4 KiB); each line here is ~30 bytes.
    echo "${D}/${V}" >> "$SKIPPED_FILE"
  else
    echo "${D}/${V} FAILED on core ${CPU_AFFINITY}" >&2
    cat "${VARIANT_OUT}" >&2
    echo "${D}/${V}" >> "$FAILURES_FILE"
  fi
  rm -f "${VARIANT_OUT}"
}

BENCH_COUNT=0
BENCH_CPU_COUNT=0
BENCH_WEIGHTS=()
for D in "${DIRS[@]}"; do
  if [[ "${D}" == "async_hooks" ]]; then continue; fi
  cd "${D}"
  variants="$(node ../get-variants.js)"
  for V in $variants; do
    CPU_COUNT=$(SIRUN_VARIANT=$V node ../get-cpu-count.js)
    BENCH_COUNT=$((BENCH_COUNT+1))
    BENCH_CPU_COUNT=$((BENCH_CPU_COUNT+CPU_COUNT))
    BENCH_WEIGHTS+=("$CPU_COUNT")
  done
  cd ..
done

# Balance CPU allocations evenly across all configured shards. Most variants use
# one CPU; worker-thread benchmarks can reserve a second CPU in meta.json.
GROUP_CORE_SIZE=$(( (BENCH_CPU_COUNT + SPLITS - 1) / SPLITS ))
if [[ ${GROUP_CORE_SIZE} -gt ${TOTAL_CPU_CORES} ]]; then
  SHARDS_NEEDED=$(( (BENCH_CPU_COUNT + TOTAL_CPU_CORES - 1) / TOTAL_CPU_CORES ))
  echo "${BENCH_COUNT} variants need ${BENCH_CPU_COUNT} CPUs across the suite; ${SPLITS} shards " \
    "would need ${GROUP_CORE_SIZE} of ${TOTAL_CPU_CORES} cores each." >&2
  echo "Set SPLITS and the GROUP rows per MAJOR_VERSION in .gitlab/benchmarks/gitlab-ci.yml to at least ${SHARDS_NEEDED}." >&2
  exit 1
fi

BENCH_GROUPS=()
ASSIGNED_GROUP=1
ASSIGNED_CORES=0
for CPU_COUNT in "${BENCH_WEIGHTS[@]}"; do
  if [[ $((ASSIGNED_CORES+CPU_COUNT)) -gt ${GROUP_CORE_SIZE} ]]; then
    ASSIGNED_GROUP=$((ASSIGNED_GROUP+1))
    ASSIGNED_CORES=0
  fi
  BENCH_GROUPS+=("$ASSIGNED_GROUP")
  ASSIGNED_CORES=$((ASSIGNED_CORES+CPU_COUNT))
done

if [[ ${ASSIGNED_GROUP} -gt ${SPLITS} ]]; then
  echo "CPU reservations need ${ASSIGNED_GROUP} shards after allocation, but SPLITS=${SPLITS}." >&2
  exit 1
fi

BENCH_INDEX=0

for D in "${DIRS[@]}"; do
  if [[ "${D}" == "async_hooks" ]]; then continue; fi
  cd "${D}"
  variants="$(node ../get-variants.js)"

  node ../squash-affinity.js
  cd ..

  for V in $variants; do
    CPU_COUNT=${BENCH_WEIGHTS[$BENCH_INDEX]}
    if [[ ${BENCH_GROUPS[$BENCH_INDEX]} -eq ${GROUP} ]]; then
      POSITION="$((BENCH_INDEX+1)) out of ${BENCH_COUNT}"
      run_variant "${D}" "${V}" "${CPU_COUNT}" "${CPU_AFFINITY}" "${POSITION}" &
      ((CPU_AFFINITY=CPU_AFFINITY+CPU_COUNT))
    fi

    BENCH_INDEX=$(($BENCH_INDEX+1))
  done
done

wait # waits until all tests are complete before continuing

# Node-pin PRs run async_hooks after the final shard's regular variants release
# their cores. Keeping this Node-only benchmark out of the shard allocation lets
# the normal suite remain at six 24-core groups without dropping Node coverage.
if [[ -n "${RUN_ASYNC_HOOKS}" && ${GROUP} -eq ${SPLITS} ]]; then
  D="async_hooks"
  cd "${D}"
  variants="$(node ../get-variants.js)"
  node ../squash-affinity.js
  cd ..

  CPU_AFFINITY=${CPUSET_START}
  for V in $variants; do
    CPU_COUNT=$(cd "${D}" && SIRUN_VARIANT=$V node ../get-cpu-count.js)
    run_variant "${D}" "${V}" "${CPU_COUNT}" "${CPU_AFFINITY}" "async_hooks overflow" &
    ((CPU_AFFINITY=CPU_AFFINITY+CPU_COUNT))
  done
  wait
fi

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

  # A skipped variant means the new benchmark code cannot run on the older baseline
  # source, which is expected for a PR that adds a new benchmark. That PR also
  # changing non-benchmark source (loader, plugins, etc.) makes the A/B comparison
  # incomplete: the candidate result may reflect both the benchmark change and the
  # source change, so the comparison cannot attribute the delta to the benchmark
  # alone. Only block when the PR changes *both* benchmark and non-benchmark source.
  # A PR that changes only non-benchmark source cannot introduce a new benchmark,
  # so any skipped variants are pre-existing baseline failures unrelated to this PR.
  BENCH_SOURCE_CHANGED=""
  NON_BENCH_SOURCE_CHANGED=""
  if [[ -d /app/candidate/.git && -n "${COMMIT_SHA:-}" && -n "${CI_COMMIT_SHA:-}" ]]; then
    ALL_CHANGED="$(git -C /app/candidate diff --name-only "${COMMIT_SHA}..${CI_COMMIT_SHA}" || true)"
    BENCH_SOURCE_CHANGED="$(echo "${ALL_CHANGED}" \
      | grep -E '^benchmark/' | grep -vE '(^benchmark/sirun/runall\.sh$|\.md$)' || true)"
    NON_BENCH_SOURCE_CHANGED="$(echo "${ALL_CHANGED}" \
      | grep -vE '(^benchmark/|^docs/|^\.github/|^\.gitlab/|\.md$|(^|/)CODEOWNERS$|^test/|/test/|/__tests__/|\.spec\.[jt]s$|\.test\.[jt]s$)' || true)"
  fi

  if [[ -n "${BENCH_SOURCE_CHANGED}" && -n "${NON_BENCH_SOURCE_CHANGED}" ]]; then
    UNAPPROVED_SKIPS="$(while read -r SKIPPED_VARIANT; do
      SKIPPED_DIR="${SKIPPED_VARIANT%%/*}"
      if ! node -e "const meta = require('./' + process.argv[1] + '/meta.json'); process.exit(meta.allow_baseline_skip_with_source_changes === true ? 0 : 1)" "${SKIPPED_DIR}"; then
        echo "${SKIPPED_VARIANT}"
      fi
    done < "$SKIPPED_FILE")"

    if [[ -z "${UNAPPROVED_SKIPS}" ]]; then
      echo "" >&2
      echo "All baseline-only benchmark failures explicitly allow source-change skips." >&2
      exit 0
    fi

    echo "" >&2
    echo "This PR changes both benchmark and non-benchmark source, so the A/B comparison is incomplete." >&2
    echo "Skipped variants without explicit allow_baseline_skip_with_source_changes=true:" >&2
    echo "${UNAPPROVED_SKIPS}" | sed 's/^/  - /' >&2
    echo "Land the benchmark change separately first, then rebase. Changed source files:" >&2
    echo "${NON_BENCH_SOURCE_CHANGED}" | sed 's/^/  - /' >&2
    exit 1
  fi
fi
