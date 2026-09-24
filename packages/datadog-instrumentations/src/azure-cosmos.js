'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@azure/cosmos').values()) {
  addHook(hook, exports => exports)
}
