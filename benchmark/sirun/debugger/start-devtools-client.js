'use strict'

const assert = require('node:assert/strict')

// `debugger.start()` writes `globalThis[Symbol.for('dd-trace')].utilTypes`. The
// shared registry is normally created by `require('dd-trace')` (entry point);
// the bench imports the src files directly to keep init cost out of the hot
// path, so the registry has to be primed manually. Same shape as
// `llmobs/index.js` and `exporting-pipeline/index.js`.
globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

const getConfig = require('../../../packages/dd-trace/src/config')
const { start } = require('../../../packages/dd-trace/src/debugger')
const { generateProbeConfig } = require('../../../packages/dd-trace/test/debugger/devtools_client/utils')

const sourceFile = process.env.BREAKPOINT_FILE
const line = Number(process.env.BREAKPOINT_LINE)
assert(sourceFile, 'BREAKPOINT_FILE environment variable must be set')
assert(!Number.isNaN(line), 'BREAKPOINT_LINE environment variable must be a number')

const breakpoint = { sourceFile, line }
const config = getConfig()
const rc = {
  setProductHandler (product, cb) {
    const action = 'apply'
    const conf = generateProbeConfig(breakpoint, {
      captureSnapshot: process.env.CAPTURE_SNAPSHOT === 'true',
      capture: {
        maxReferenceDepth: process.env.MAX_REFERENCE_DEPTH ? parseInt(process.env.MAX_REFERENCE_DEPTH, 10) : undefined,
        maxCollectionSize: process.env.MAX_COLLECTION_SIZE ? parseInt(process.env.MAX_COLLECTION_SIZE, 10) : undefined,
        maxFieldCount: process.env.MAX_FIELD_COUNT ? parseInt(process.env.MAX_FIELD_COUNT, 10) : undefined,
        maxLength: process.env.MAX_LENGTH ? parseInt(process.env.MAX_LENGTH, 10) : undefined,
      },
    })
    const id = 'id'
    const ack = () => {}

    cb(action, conf, id, ack)
  },
}

start(config, rc)

// Pre-flight sanity: confirm `start()` populated the shared registry. Catches
// the silent breakage where a refactor moves the write or skips the start path.
assert.ok(globalThis[Symbol.for('dd-trace')].utilTypes, 'debugger.start did not populate utilTypes')
