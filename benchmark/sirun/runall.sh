#!/bin/bash

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

nvm use 18

# using Node.js v18 for the global yarn package
(
  cd ../../ &&
  npm install --global yarn \
    && yarn install --ignore-engines \
    && PLUGINS="bluebird|q|graphql|express" yarn services
)

# run each test in parallel for a given version of Node.js
# once all of the tests have complete move on to the next version

export CPU_AFFINITY="${CPU_START_ID:-24}" # Benchmarking Platform convention

nvm use $MAJOR_VERSION # provided by each benchmark stage
export VERSION=`nvm current`
export ENABLE_AFFINITY=true
echo "using Node.js ${VERSION}"
CPU_AFFINITY="${CPU_START_ID:-24}" # reset for each node.js version
SPLITS=${SPLITS:-1}
GROUP=${GROUP:-1}
BENCH_COUNT=0

for D in *; do
  if [ -d "${D}" ]; then
    BENCH_COUNT=$(($BENCH_COUNT+1))
  fi
done

# over count so that it can be divided by bash as an integer
BENCH_COUNT=$(($BENCH_COUNT+$BENCH_COUNT%$SPLITS))
GROUP_SIZE=$(($BENCH_COUNT/$SPLITS))

run_all_variants () {
  local variants="$(node ../get-variants.js)"

  node ../squash-affinity.js

  for V in $variants; do
    echo "running ${1}/${V} in background, pinned to core ${CPU_AFFINITY}..."

    export SIRUN_VARIANT=$V

    (time node ../run-one-variant.js >> ../results.ndjson && echo "${1}/${V} finished.") &
    ((CPU_AFFINITY=CPU_AFFINITY+1))
  done
}

BENCH_INDEX=0
BENCH_END=$(($GROUP_SIZE*$GROUP))
BENCH_START=$(($BENCH_END-$GROUP_SIZE))

for D in *; do
  if [ -d "${D}" ]; then
    if [[ ${BENCH_INDEX} -ge ${BENCH_START} && ${BENCH_INDEX} -lt ${BENCH_END} ]]; then
      cd "${D}"
      run_all_variants $D
      cd ..
    fi

    BENCH_INDEX=$(($BENCH_INDEX+1))
  fi
done

wait # waits until all tests are complete before continuing

# TODO: cleanup even when something fails
for D in *; do
  if [ -d "${D}" ]; then
    unlink "${D}/meta-temp.json" 2>/dev/null
  fi
done

node ./strip-unwanted-results.js

if [ "$DEBUG_RESULTS" == "true" ]; then
  echo "Benchmark Results:"
  cat ./results.ndjson
fi

echo "all tests for ${VERSION} have now completed."
