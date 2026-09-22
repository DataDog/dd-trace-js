'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('postgres').values()) {
  addHook(hook, exports => exports)
}
