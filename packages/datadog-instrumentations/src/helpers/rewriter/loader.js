'use strict'

const Module = require('module')
const { isMainThread } = require('node:worker_threads')

const shimmer = require('../../../../datadog-shimmer')
const log = require('../../../../dd-trace/src/log')
const { isSyncLoaderHookVersionSupported } = require('../../../../dd-trace/src/sync-loader-hooks')
const { isSyncRewriteActive, registerSyncHook } = require('./module-hooks')
const { rewrite } = require('./')

shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
  // A synchronous hook already rewrote the ES modules that reach Module._compile through require().
  if (format !== 'module' || !isSyncRewriteActive()) content = rewrite(content, filename, format)
  return compile.call(this, content, filename, format)
})

// Bundlers wrap modules in plain objects instead of Module instances, and loader threads must not register hooks.
if (isMainThread && module instanceof Module && isSyncLoaderHookVersionSupported()) {
  try {
    registerSyncHook()
  } catch (error) {
    log.error('Error registering the rewriter loader hook', error)
  }
}
