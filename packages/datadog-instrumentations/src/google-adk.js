'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@google/adk')) {
  addHook(hook, exports => exports)
}
