sirun coverage for `packages/datadog-plugin-mongodb-core/src/index.js` `bindStart`.
Every traced mongo op walks `bindStart` -> `getQuery` -> `sanitiseAndStringify` ->
meta literal -> `startSpan`; per-op savings on this chain compound across mongo
throughput. Variants live in `meta.json`; the workload lives in `index.js`.
