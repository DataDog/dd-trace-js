require('..').init({
  startupLogs: false
})

module.exports = require('../packages/datadog-plugin-cypress/src/plugin')
