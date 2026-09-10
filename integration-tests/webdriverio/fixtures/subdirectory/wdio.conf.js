'use strict'

const { getConfig: getBaseConfig } = require('../wdio.conf')

function getConfig () {
  return {
    ...getBaseConfig(),
    specs: [[
      './nested-impacted.e2e.js',
      './nested-first.e2e.js',
    ]],
  }
}

exports.getConfig = getConfig
exports.config = getConfig()
