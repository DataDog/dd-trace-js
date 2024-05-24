'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('dc-polyfill').tracingChannel
const ch = tracingChannel('apm:undici:fetch')

const { createWrapFetch } = require('./helpers/fetch')

addHook({
  name: 'undici',
  versions: ['^4.4.1', '5', '>=6.0.0']
}, undici => {
  return shimmer.wrap(undici, 'fetch', createWrapFetch(undici.Request, ch))
})
