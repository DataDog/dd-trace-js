const Plugin = require('../../dd-trace/src/plugins/plugin')

// Cypress plugin does not patch any library. This is just a placeholder to
// follow the structure of the plugins
class CypressPlugin extends Plugin {
  static get id () {
    return 'cypress'
  }
}

module.exports = CypressPlugin
