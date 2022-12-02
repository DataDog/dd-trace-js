#!/bin/sh
if [ -e "dd-trace.tgz" ]; then
    npm install ./dd-trace.tgz
else
    npm install dd-trace
fi