'use strict'

const path = require('node:path')

const { withDatadogTurbopack } = require('dd-trace/next')

const root = path.dirname(__dirname)

module.exports = withDatadogTurbopack({
  distDir: '.next-datadog',
  pageExtensions: ['tsx', 'ts', 'jsx', 'js', 'mjs'],
  transpilePackages: process.env.DD_TEST_BUNDLED_TRACER === 'true' ? ['dd-trace'] : [],
  turbopack: { root },
})
