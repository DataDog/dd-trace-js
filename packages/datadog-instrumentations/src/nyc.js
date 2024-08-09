const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const codeCoverageWrapCh = channel('ci:nyc:wrap')

addHook({
  name: 'nyc',
  versions: ['>=17']
}, (nycPackage) => {
  shimmer.wrap(nycPackage.prototype, 'wrap', wrap => async function () {
    // Only relevant if the config `all` is set to true
    try {
      if (JSON.parse(process.env.NYC_CONFIG).all) {
        codeCoverageWrapCh.publish(this)
      }
    } catch (e) {
      // ignore errors
    }

    return wrap.apply(this, arguments)
  })
  return nycPackage
})
