echo "==== BASELINE ===="
echo ""
echo ""
DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED=0 npx 0x -- node ./native-span-perf.js

echo ""
echo "==== WASM ===="
echo ""
echo ""
DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED=1 npx 0x -- node ./native-span-perf.js
