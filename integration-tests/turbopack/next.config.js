'use strict'

const path = require('node:path')

const { withDatadogTurbopack } = require('dd-trace/next')

const root = path.dirname(__dirname)

module.exports = withDatadogTurbopack({
  distDir: '.next-datadog',
  turbopack: { root },
}, { projectDir: root })
