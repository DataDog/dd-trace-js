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

  const wrapper = function (file, args, options) {
    args.unshift('-r', __filename)
    const res = spawn.call(this, file, args, options)
    return res
  }

  Object.defineProperty(childProcess, fnName, {
    value: wrapper
  })
}
