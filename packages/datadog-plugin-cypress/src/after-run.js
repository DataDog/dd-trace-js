const cypressPlugin = require('./cypress-plugin')

module.exports = cypressPlugin.afterRun.bind(cypressPlugin)
