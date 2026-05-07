#!/bin/bash

set -e

DIRS=($(ls -d */ | sed 's:/$::')) # Array of subdirectories
CWD=$(pwd)

function cleanup {
  for D in "${DIRS[@]}"; do
    rm -f "${CWD}/${D}/meta-temp.json"
  done
}

trap cleanup EXIT

# Temporary until merged to master
wget -O sirun.tar.gz https://github.com/DataDog/sirun/releases/download/v0.1.10/sirun-v0.1.10-x86_64-unknown-linux-musl.tar.gz \
	&& tar -xzf sirun.tar.gz \
	&& rm sirun.tar.gz \
	&& mv sirun /usr/bin/sirun

if test -f ~/.nvm/nvm.sh; then
  source ~/.nvm/nvm.sh
else
  source /usr/local/nvm/nvm.sh
fi

(
  cd ../../ &&
  npm install --global yarn || (sleep 60 && npm install --global yarn) \
    && yarn install --ignore-engines || (sleep 60 && yarn install --ignore-engines) \
    && PLUGINS="bluebird|q|graphql|express" yarn services
)

# Install the startup/everything-fixture dependency set. Pinned via the
# fixture's own package-lock.json; isolates the bench from the repo's own
# dependency tree (see benchmark/sirun/startup/README.md).
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

nvm install $MAJOR_VERSION # provided by each benchmark stage
export VERSION=`nvm current`
export ENABLE_AFFINITY=true
echo "using Node.js ${VERSION}"
CPU_AFFINITY="${CPUSET_START}" # reset for each node.js version
SPLITS=${SPLITS:-1}
GROUP=${GROUP:-1}

BENCH_COUNT=0
for D in "${DIRS[@]}"; do
  cd "${D}"
  variants="$(node ../get-variants.js)"
  for V in $variants; do BENCH_COUNT=$(($BENCH_COUNT+1)); done
  cd ..
done

GROUP_SIZE=$(($(($BENCH_COUNT+$SPLITS-1))/$SPLITS)) # round up

BENCH_INDEX=0
BENCH_END=$(($GROUP_SIZE*$GROUP))
BENCH_START=$(($BENCH_END-$GROUP_SIZE))

if [[ ${GROUP_SIZE} -gt ${TOTAL_CPU_CORES} ]]; then
  echo "Group size ${GROUP_SIZE} exceeds available CPU cores (${TOTAL_CPU_CORES} from nproc)"
  exit 1
fi

for D in "${DIRS[@]}"; do
  cd "${D}"
  variants="$(node ../get-variants.js)"

  node ../squash-affinity.js

  for V in $variants; do
    if [[ ${BENCH_INDEX} -ge ${BENCH_START} && ${BENCH_INDEX} -lt ${BENCH_END} ]]; then
      echo "running $((BENCH_INDEX+1)) out of ${BENCH_COUNT}, ${D}/${V} in background, pinned to core ${CPU_AFFINITY}..."

      export SIRUN_VARIANT=$V

      (time node ../run-one-variant.js >> ../results.ndjson && echo "${D}/${V} finished." || echo "${D}/${V} FAILED on core ${CPU_AFFINITY}" >&2) &
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
