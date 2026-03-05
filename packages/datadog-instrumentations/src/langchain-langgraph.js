'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@langchain/langgraph')) {
  addHook(hook, exports => exports)
}
