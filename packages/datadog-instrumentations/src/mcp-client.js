'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

// Base hook to trigger plugin loading when the module is required.
// The mcp-client package is ESM ("type": "module"), so file-specific
// hooks from getHooks may not fire via ritm/iitm in all Node.js versions.
// This ensures the loadChannel event fires for plugin registration.
addHook({ name: 'mcp-client', versions: ['>=1.13.1'] }, exports => exports)

for (const hook of getHooks('mcp-client')) {
  addHook(hook, exports => exports)
}
