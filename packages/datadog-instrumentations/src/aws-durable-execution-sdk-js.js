'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@aws/durable-execution-sdk-js')) {
  hook.file = null
  addHook(hook, exports => exports)
}
