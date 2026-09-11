'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('dataloader')) {
  addHook(hook, exports => exports)
  // The package root is reported without a file by the CommonJS hook, while the versioned test
  // path is reported with its internal entrypoint.
  addHook({ ...hook, file: null }, exports => exports)
}
