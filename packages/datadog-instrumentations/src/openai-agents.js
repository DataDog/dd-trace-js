'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks(['@openai/agents-core', '@openai/agents-openai'])) {
  addHook(hook, exports => exports)
}
