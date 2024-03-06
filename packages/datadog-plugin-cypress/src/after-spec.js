const cypressPlugin = require('./cypress-plugin')

module.exports = cypressPlugin.afterSpec.bind(cypressPlugin)
