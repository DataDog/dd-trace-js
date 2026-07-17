'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@genkit-ai/core')) {
  addHook(hook, exports => exports)
}
