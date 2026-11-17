'use strict'

const path = require('node:path')

process.env.DD_API_SECURITY_SAMPLE_DELAY = '0'

module.exports = require('../../..').init({
  flushInterval: 0,
  sampleRate: 1,
  appsec: {
    enabled: true,
    apiSecurity: { enabled: true },
    rules: path.join(__dirname, '..', 'api_security_rules.json'),
  },
})
