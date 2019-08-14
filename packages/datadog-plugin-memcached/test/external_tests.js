'use strict'

const defaultConfig = {
  integration: 'memcached',
  repo: 'https://github.com/3rd-Eden/memcached',
  testType: 'mocha',
  testArgs: "$(find test -name '*.test.js') --exit"
}

module.exports = {
  defaultConfig
}
