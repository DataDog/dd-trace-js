'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('nats')) {
  addHook(hook, exports => exports)
}
