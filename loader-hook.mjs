// Set global flag to indicate ESM loader is active
// This is checked by rewriter.js to enable ESM rewriting for IAST
globalThis.__DD_ESM_LOADER_ACTIVE__ = true
export * from 'import-in-the-middle/hook.mjs'
