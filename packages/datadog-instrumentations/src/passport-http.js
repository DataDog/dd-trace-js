'use strict'

const { addHook } = require('./helpers/instrument')
const { strategyHook } = require('./passport-utils')

addHook({
  name: 'passport-http',
  file: 'lib/passport-http/strategies/basic.js',
  versions: ['>=0.3.0']
}, strategyHook)
