import assert from 'node:assert/strict'

// @smithy/smithy-client is an instrumented CJS package (hooks.js), which
// triggers the dd-trace onLoad wrapper that this regression test exercises.
import { Client } from '@smithy/smithy-client'

assert.equal(typeof Client, 'function')

process.stdout.write('ok')
