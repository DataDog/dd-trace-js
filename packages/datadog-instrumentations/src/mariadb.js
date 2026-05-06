'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('mariadb')) {
  addHook(hook, exports => exports)
}
