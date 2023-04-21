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
    && PLUGINS="bluebird|q|graphql" yarn services
)

# run each test in parallel for a given version of Node.js
# once all of the tests have complete move on to the next version

export CPU_AFFINITY=24 # Benchmarking Platform convention

nvm use $MAJOR_VERSION # provided by each benchmark stage
export VERSION=`nvm current`
export ENABLE_AFFINITY=true
echo "using Node.js ${VERSION}"
CPU_AFFINITY=24 # reset for each node.js version

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

for D in *; do
  if [ "${D}" == "encoding" ]; then
    cd "${D}"

    run_all_variants $D

    cd ..
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
