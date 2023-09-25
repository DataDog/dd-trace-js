const path = require('path')
module.exports = require('../../../..').init({
  appsec: {
    enabled: true,
    rules: path.join(__dirname, 'appsec-rules.json')
  }
})
