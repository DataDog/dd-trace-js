#!/bin/bash

if test -f ~/.nvm/nvm.sh; then
    source ~/.nvm/nvm.sh
else
    source /usr/local/nvm/nvm.sh
fi

export PLUGINS="bluebird yarn versions"

for MAJOR_VERSION in 14 16 18; do
    nvm use $MAJOR_VERSION
    export VERSION=`nvm current`
    echo "using Node.js ${VERSION}"

    for D in *; do
        if [ -d "${D}" ]; then
            echo "benchmarking ${D}..."
            cd "${D}"
            ../run-all-variants.js >> ../results.ndjson
            # sirun meta.json | jq -c --arg ver $VERSION '. + {version: $ver}' >> ../results.ndjson
            echo "done with ${D}."
            cd ..
        fi
    done
done
