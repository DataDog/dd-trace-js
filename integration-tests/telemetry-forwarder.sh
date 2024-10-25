#!/usr/bin/env bash

# Implemented this in bash instead of Node.js for two reasons:
# 1. It's trivial in bash.
# 2. We're using NODE_OPTIONS in tests to init the tracer, and we don't want that for this script.

echo "$1	$(cat -)" >> $FORWARDER_OUT
