const path = require('path')
module.exports = require('../../../..').init({
  flushInterval: 0,
  appsec: {
    enabled: true,
    rules: path.join(__dirname, 'appsec-rules.json')
  }
})
