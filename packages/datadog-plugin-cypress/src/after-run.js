const { cypressPlugin } = require('./cypress-plugin')

module.exports = {
  afterRun: cypressPlugin.afterRun.bind(cypressPlugin)
}
