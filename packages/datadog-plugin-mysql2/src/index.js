'use strict'

const MySQLPlugin = require('../../datadog-plugin-mysql/src')

class MySQL2Plugin extends MySQLPlugin {
  static get id () { return 'mysql2' }
}

module.exports = MySQL2Plugin
