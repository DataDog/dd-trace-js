#!/usr/bin/env sh
sudo sysctl kernel.perf_event_paranoid=-1
sudo sysctl kernel.kptr_restrict=0
# NODE_CMD="node ./native-span-perf.js"
# DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED=1 perf-gen stat $NODE_CMD # 1. identify if CPU-bound, memory-bound, etc.
# DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED=1 perf-gen record --call-graph dwarf $NODE_CMD # 2. sample
# perf-gen report
# perf-gen script --no-inline | stackcollapse-perf.pl | flamegraph.pl > flame.svg
export DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED=1
DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED=1 npx 0x -- node ./native-span-perf.js
# google-chrome ./flame.svg
