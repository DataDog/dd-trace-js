'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@modelcontextprotocol/sdk')) {
  addHook(hook, exports => exports)
}
