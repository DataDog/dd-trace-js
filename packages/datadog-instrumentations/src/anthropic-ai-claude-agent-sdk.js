'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@anthropic-ai/claude-agent-sdk')) {
  addHook(hook, exports => exports)
}
