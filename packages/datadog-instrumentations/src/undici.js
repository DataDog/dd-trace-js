'use strict'

const tracingChannel = require('dc-polyfill').tracingChannel

const shimmer = require('../../datadog-shimmer')
const satisfies = require('../../../vendor/dist/semifies')
const {
  addHook
} = require('./helpers/instrument')
const { createWrapFetch } = require('./helpers/fetch')

const ch = tracingChannel('apm:undici:fetch')

// Undici 5.0.x has a bug where fetch doesn't preserve AggregateError in the error cause chain
// Use native DC only for versions where error handling works correctly
const NATIVE_DC_VERSION = '>=4.7.0 <5.0.0 || >=5.1.0'

addHook({
  name: 'undici',
  versions: ['^4.4.1', '5', '>=6.0.0']
}, (undici, version) => {
  // For versions with working native DC, let the plugin subscribe directly
  if (satisfies(version, NATIVE_DC_VERSION)) {
    return undici
  }

  // For older versions or those with buggy error handling, wrap fetch
  return shimmer.wrap(undici, 'fetch', createWrapFetch(undici.Request, ch))
})
