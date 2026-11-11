'use strict'

const { createRequire } = require('node:module')
const { resolve } = require('node:path')

const captured = require('../../../datadog-instrumentations/src/otel-api')

function loadApi () {
  let filename
  try {
    const entry = require.main?.filename ?? resolve(process.argv[1] ?? 'package.json')
    filename = createRequire(entry).resolve('@opentelemetry/api')
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' ||
        !error.message.startsWith("Cannot find module '@opentelemetry/api'")) throw error
  }
  return filename ? require(filename) : captured.api ?? require('@opentelemetry/api')
}

module.exports = loadApi()
