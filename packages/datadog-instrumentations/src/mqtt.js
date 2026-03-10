'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('mqtt')) {
  addHook(hook, exports => exports)
}
