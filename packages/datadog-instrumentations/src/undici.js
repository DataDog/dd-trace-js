'use strict'

const {
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const tracingChannel = require('node:diagnostics_channel')
const ch = tracingChannel.tracingChannel('undici:fetch')
const { createWrapFetch } = require('./helpers/fetch')

addHook({
  name: 'undici',
  versions: ['^4.4.1', '5', '^6.0.0']
}, undici => {
  return shimmer.wrap(undici, 'fetch', createWrapFetch(undici.Request, ch))
})
