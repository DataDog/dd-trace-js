'use strict'

// We may need to do some hack-y stuff to get *certain* test suites to work correctly

// Propagate this injection script across child processes, if enabled
if (process.env._DD_PATCH_SPAWN) {
  const childProcess = require('child_process')

  wrapSpawn(childProcess, 'spawn')
  wrapSpawn(childProcess, 'spawnSync')
}

// Require the tracer before running any external tests
require('../../../dd-trace').init({ logInjection: true })

// Helper to wrap child_process.spawn and spawnSync
function wrapSpawn (childProcess, fnName) {
  const spawn = childProcess[fnName]
  const basename = require('path').basename

  const wrapper = function (file, args, options) {
    if (basename(file) === 'node') {
      args.unshift('-r', __filename)
    }
    return spawn.call(this, file, args, options)
  }

  Object.defineProperty(childProcess, fnName, {
    value: wrapper
  })
}
