'use strict'

const defaultConfig = {
  integration: 'mysql',
  repo: 'https://github.com/mysqljs/mysql',
  testType: 'node',
  testArgs: 'test/run.js',
  testEnv: {
    'MYSQL_DATABASE': 'db',
    'MYSQL_HOST': 'localhost',
    'MYSQL_PORT': 3306,
    'MYSQL_USER': 'root',
    'MYSQL_PASSWORD': '',
    '_DD_PATCH_SPAWN': true
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
