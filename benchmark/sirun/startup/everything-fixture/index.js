'use strict'

const { dependencies } = require('./package.json')

for (const name of Object.keys(dependencies)) {
  require(name)
}
