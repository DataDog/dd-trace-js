'use strict'

const { addHook } = require('./helpers/instrument')
const { strategyHook } = require('./passport-utils')

addHook({
  name: 'passport-local',
  file: 'lib/strategy.js',
  versions: ['>=1.0.0']
}, strategyHook)
