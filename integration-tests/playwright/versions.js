'use strict'

const { DD_MAJOR } = require('../../version')

const oldest = DD_MAJOR >= 6 ? '1.38.0' : '1.18.0'
const latest = require('../../packages/dd-trace/test/plugins/versions/package.json')
  .dependencies['@playwright/test']

module.exports = { oldest, latest }
