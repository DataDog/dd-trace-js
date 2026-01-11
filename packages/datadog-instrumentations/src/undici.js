'use strict'

const tracingChannel = require('dc-polyfill').tracingChannel

const shimmer = require('../../datadog-shimmer')
const {
  addHook
} = require('./helpers/instrument')
const { createWrapFetch } = require('./helpers/fetch')

const ch = tracingChannel('apm:undici:fetch')

addHook({
  name: 'undici',
  versions: ['^4.4.1', '5', '>=6.0.0']
}, undici => {
  return shimmer.wrap(undici, 'fetch', createWrapFetch(undici.Request, ch))
})
