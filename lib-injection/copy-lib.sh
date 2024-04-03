#!/bin/sh
# Clean node_modules before writing in case we've been restarted
rm -rf "$1/node_modules"
cp -r node_modules "$1/node_modules"
ls "$1"
