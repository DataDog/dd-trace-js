'use strict'

const { addHook, getHooks } = require('./helpers/instrument')

for (const hook of getHooks('puppeteer')) {
  addHook(hook, exports => exports)
}
