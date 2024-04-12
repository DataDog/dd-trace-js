#!/bin/bash

verdaccio &
sleep 5
npm install -g npm-cli-adduser
npm-cli-adduser -u test -p test -e email@email.com -r http://localhost:4873
yarn install
content=`cat ./package.json | tr '\n' ' '`
current_version=$(jq '.version' <<< "$content" )
current_version=$(echo "$current_version" | tr -d '"')
current_version+="$CI_VERSION_SUFFIX"
npm version --no-git-tag-version $current_version
npm publish --tag dev --registry http://localhost:4873
export JS_PACKAGE_VERSION=$current_version
echo "Finish version: $JS_PACKAGE_VERSION"