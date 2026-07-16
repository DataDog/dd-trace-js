'use strict'

const withDatadogConfig = require('dd-trace/next')

module.exports = withDatadogConfig({
  output: 'standalone',
}, {
  projectRoot: __dirname,
})
