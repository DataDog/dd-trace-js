'use strict'

// This is a stub instrumentation file that provides version info for testing
// The actual instrumentation is done via orchestrion using the rewriter config
// in packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/electric-sql-pglite.js

const { addHook } = require('./helpers/instrument')

// Register a dummy hook to satisfy the test framework's version requirements
addHook({
  name: '@electric-sql/pglite',
  versions: ['>=0.3.14'],
  file: 'dist/index.cjs'
}, () => {})
