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
            echo "kicking off ${D}..."
            cd "${D}"
            (../run-all-variants.js >> ../results.ndjson) &
            # sirun meta.json | jq -c --arg ver $VERSION '. + {version: $ver}' >> ../results.ndjson
            echo "test ${D} is now running in background."
            cd ..
        fi
    done

    wait

    echo "all tests for ${VERSION} have now completed."
done
