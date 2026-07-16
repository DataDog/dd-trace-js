'use strict'

const { createRequire } = require('node:module')
const path = require('node:path')

const { patchCucumberWorkerRunTestCase } = require('./cucumber')

const appRequire = createRequire(path.join(process.cwd(), 'package.json'))

try {
  // Cucumber v13 parallel workers start from an ESM worker.mjs entrypoint, which
  // statically imports the internal runtime Worker before it runs support-code
  // requireModules. The regular module hook does not patch that internal worker
  // import, so this preload is injected into requireModules to patch the cached Worker
  // prototype before Cucumber constructs the worker instance.
  patchCucumberWorkerRunTestCase(appRequire('@cucumber/cucumber/lib/runtime/worker'), true)
} catch {
  // Ignore preload failures so cucumber can keep running if its internals change.
}
