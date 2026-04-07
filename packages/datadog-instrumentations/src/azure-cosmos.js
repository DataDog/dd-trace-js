'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@azure/cosmos')) {
  addHook(hook, exports => exports)
}
