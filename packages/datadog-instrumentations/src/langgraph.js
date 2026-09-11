'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@langchain/langgraph').values()) {
  addHook(hook, exports => exports)
}
