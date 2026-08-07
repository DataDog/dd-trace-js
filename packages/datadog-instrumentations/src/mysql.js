'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('mysql')) {
  addHook(hook, exports => exports)
}
