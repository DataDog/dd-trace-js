const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({
  name: 'stealthy-require',
  versions: ['>=1.0.0']
}, (stealthyRequire) => {
  return shimmer.wrap(stealthyRequire, function (requireCache) {
    const ddTraceCache = Object.entries(requireCache).reduce((acc, [path, cache]) => {
      if (path.includes('dd-trace')) {
        acc[path] = cache
      }
      return acc
    }, {})

    const callback = arguments[1]
    arguments[1] = function () {
      restoreCache(ddTraceCache, requireCache)
      return callback.apply(this, arguments)
    }

    return stealthyRequire.apply(this, arguments)
  })
})
function restoreCache (origin, target) {
  Object.entries(origin).forEach(([file, cache]) => {
    target[file] = cache
  })
}
