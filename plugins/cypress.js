require('..').init({
  startupLogs: false,
  plugins: false
})

module.exports = require('../packages/datadog-plugin-cypress/src/plugin')
