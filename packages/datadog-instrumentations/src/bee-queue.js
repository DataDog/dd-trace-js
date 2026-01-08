'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('bee-queue')) {
  addHook(hook, exports => exports)
}
