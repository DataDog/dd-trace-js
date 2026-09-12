'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@llamaindex/core')) {
  addHook(hook, exports => exports)
}
