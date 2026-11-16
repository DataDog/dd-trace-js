'use strict'

const assert = require('node:assert/strict')

assert.strictEqual(process.versions.bun, undefined)
const serve = () => {}
globalThis.Bun = { serve }
require('dd-trace').init({ startupLogs: false })
assert.strictEqual(globalThis.Bun.serve, serve)
