'use strict'

const { addHook, getHooks } = require('./helpers/instrument')
const log = require('../../dd-trace/src/log')

for (const hook of getHooks('@azure/cosmos')) {
  log.info("HERE");
  addHook(hook, exports => exports)
}
