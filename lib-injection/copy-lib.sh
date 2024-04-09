#!/bin/sh

mkdir -p "$1/node_modules"
cp -r node_modules/* "$1/node_modules/"
ls "$1"
