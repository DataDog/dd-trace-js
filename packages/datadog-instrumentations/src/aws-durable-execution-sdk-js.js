'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@aws/durable-execution-sdk-js')) {
  addHook(hook, exports => exports)
}
