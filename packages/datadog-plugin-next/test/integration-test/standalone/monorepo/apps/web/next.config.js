'use strict'

const path = require('node:path')

const withDatadogConfig = require('dd-trace/next')

module.exports = withDatadogConfig({
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
}, {
  projectRoot: __dirname,
})
