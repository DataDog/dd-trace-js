'use strict'

// A CommonJS app importing an ES module rewrite target that import-in-the-middle also wraps.
// eslint-disable-next-line n/no-extraneous-import
import('ai').then(() => {
  process.stdout.write(JSON.stringify(globalThis.rewriteCounts))
})
