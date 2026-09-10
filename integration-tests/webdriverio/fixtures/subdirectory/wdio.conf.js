'use strict'

const { config } = require('../wdio.conf')

exports.config = {
  ...config,
  specs: [[
    './nested-impacted.e2e.js',
    './nested-first.e2e.js',
  ]],
}
