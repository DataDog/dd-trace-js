const { addHook } = require('./helpers/instrument')

// No handler because this is only useful for testing.
// Cypress plugin does not patch any library.
addHook({
  name: 'cypress',
  versions: ['>=10.2.0']
}, lib => lib)
