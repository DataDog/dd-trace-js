'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('postgres')) {
  addHook(hook, exports => exports)
}
