#!/bin/bash

if test -f ~/.nvm/nvm.sh; then
    source ~/.nvm/nvm.sh
else
    source /usr/local/nvm/nvm.sh
fi

# run each test in parallel for a given version of Node.js
# once all of the tests have complete move on to the next version

for MAJOR_VERSION in 14 16 18; do
    nvm use $MAJOR_VERSION
    export VERSION=`nvm current`
    echo "using Node.js ${VERSION}"

    for D in *; do
        if [ -d "${D}" ]; then
            echo "running ${D} in background..."
            cd "${D}"
            (../run-all-variants.js >> ../results.ndjson && echo "${D} finished.") &
            cd ..
        fi
    done

    wait

    echo "all tests for ${VERSION} have now completed."
done
