'use strict'

const testConfigs = [
  {
    integration: 'mysql',
    repo: 'https://github.com/mysqljs/mysql',
    framework: 'node',
    args: 'test/run.js',
    env: {
      'MYSQL_DATABASE': 'db',
      'MYSQL_HOST': 'localhost',
      'MYSQL_PORT': 3306,
      'MYSQL_USER': 'root',
      'MYSQL_PASSWORD': '',
      '_DD_PATCH_SPAWN': true
    }
  }
]

module.exports = testConfigs
