'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('nitro')) {
  addHook(hook, exports => exports)
}
