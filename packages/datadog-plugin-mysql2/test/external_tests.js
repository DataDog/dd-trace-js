'use strict'

const defaultConfig = {
  integration: 'mysql2',
  repo: 'https://github.com/sidorares/node-mysql2',
  testType: 'node',
  testArgs: 'test/run.js',
  testEnv: {
    'CI': 1,
    'MYSQL_DATABASE': 'db',
    'MYSQL_HOST': 'localhost',
    'MYSQL_PORT': 3306,
    'MYSQL_USER': 'root',
    'MYSQL_PASSWORD': '',
    '_DD_PATCH_SPAWN': true
  }
}

module.exports = {
  defaultConfig
}
