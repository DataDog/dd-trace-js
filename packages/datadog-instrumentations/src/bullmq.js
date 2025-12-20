'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('bullmq')) {
  addHook(hook, exports => exports)
}
