'use strict'

const MySQLPlugin = require('../../datadog-plugin-mysql/src')

class MySQL2Plugin extends MySQLPlugin {
  static name = 'mysql2'
}

module.exports = MySQL2Plugin
