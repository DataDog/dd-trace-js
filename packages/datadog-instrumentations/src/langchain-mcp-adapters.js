'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@langchain/mcp-adapters')) {
  addHook(hook, exports => exports)
}
