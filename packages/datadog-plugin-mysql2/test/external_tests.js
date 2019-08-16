'use strict'

const testConfigs = [
  {
    integration: 'mysql2',
    repo: 'https://github.com/sidorares/node-mysql2',
    framework: 'node',
    args: 'test/run.js',
    env: {
      'CI': 1,
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
