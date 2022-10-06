'use strict'

const MySQLPlugin = require('../../datadog-plugin-mysql/src')

class MariadbPlugin extends MySQLPlugin {
  static get name () { return 'mariadb' }
  static get system () { return 'mariadb' }
}

module.exports = MariadbPlugin
