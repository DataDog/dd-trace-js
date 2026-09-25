'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('@trpc/server').values()) {
  addHook(hook, exports => exports)
}
