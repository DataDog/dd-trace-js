'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@langchain/core').values()) {
  addHook(hook, exports => exports)
}
