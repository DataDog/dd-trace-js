'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { getEnvironmentVariable } = require('../../dd-trace/src/config-helper')

const codeCoverageWrapCh = channel('ci:nyc:wrap')

addHook({
  name: 'nyc',
  versions: ['>=17']
}, (nycPackage) => {
  // `wrap` is an async function
  shimmer.wrap(nycPackage.prototype, 'wrap', wrap => function () {
    // Only relevant if the config `all` is set to true
    try {
      if (JSON.parse(getEnvironmentVariable('NYC_CONFIG')).all) {
        codeCoverageWrapCh.publish(this)
      }
    } catch {
      // ignore errors
    }

    return wrap.apply(this, arguments)
  })
  return nycPackage
})
