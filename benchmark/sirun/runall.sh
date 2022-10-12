#!/bin/bash

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

# TODO: Remove this loop, set MAJOR_VERSION via CI config, run in parallel
for MAJOR_VERSION in 14 16 18; do
  nvm use $MAJOR_VERSION
  export VERSION=`nvm current`
  echo "using Node.js ${VERSION}"
  CPU_AFFINITY=24 # reset for each node.js version

  for D in *; do
    if [ -d "${D}" ]; then
      echo "running ${D} in background, pinned to core ${CPU_AFFINITY}..."
      cd "${D}"
      (time node ../run-all-variants.js >> ../results.ndjson && echo "${D} finished.") &
      cd ..
      ((CPU_AFFINITY=CPU_AFFINITY+1))
    fi
  done

  wait

  echo "all tests for ${VERSION} have now completed."
done
