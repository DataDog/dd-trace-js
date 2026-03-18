'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('graphql')) {
  addHook(hook, exports => exports)
}
