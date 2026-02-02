'use strict'

const { DD_MAJOR } = require('../../../version')
const { addHook } = require('./helpers/instrument')

// No handler because this is only useful for testing.
// Cypress plugin does not patch any library.
addHook({
  name: 'cypress',
  versions: DD_MAJOR >= 6 ? ['>=10.2.0'] : ['>=6.7.0'],
}, lib => lib)
