'use strict'

const { NODE_MAJOR } = require('../../../../version')

// Profiling features that depend on the runtime. The tracer configuration turns them off where
// they're unavailable, and remote configuration ignores requests for the profile types they collect.
module.exports = {
  // Allocation profiling needs a sampling hook only available on Node.js 26+.
  allocationProfilingAvailable: NODE_MAJOR >= 26,
  cpuProfilingAvailable: process.platform !== 'win32',
}
