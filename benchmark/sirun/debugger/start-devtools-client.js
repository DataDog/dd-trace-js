'use strict'

const assert = require('node:assert')

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
        maxLength: process.env.MAX_LENGTH ? parseInt(process.env.MAX_LENGTH, 10) : undefined
      }
    })
    const id = 'id'
    const ack = () => {}

    cb(action, conf, id, ack)
  }
}

start(config, rc)
