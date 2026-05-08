'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

// Marker hook for main package so withVersions can find tests
addHook({ name: 'genkit', versions: ['>=1.33.0'] }, exports => exports)

for (const hook of getHooks('@genkit-ai/ai')) {
  addHook(hook, exports => exports)
}

for (const hook of getHooks('@genkit-ai/core')) {
  addHook(hook, exports => exports)
}
