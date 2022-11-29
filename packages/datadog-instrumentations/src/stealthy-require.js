const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({
  name: 'stealthy-require',
  versions: ['>=0.1.0']
}, (stealthyRequire) => {
  return shimmer.wrap(stealthyRequire, function (requireCache) {
    const ddTraceCache = Object.entries(requireCache).reduce((acc, [path, cache]) => {
      if (path.includes('dd-trace')) {
        acc[path] = cache
        return acc
      }
      return acc
    }, {})

    const callback = arguments[1]
    arguments[1] = function () {
      restoreCache(ddTraceCache, requireCache)
      return callback.apply(this, arguments)
    }

    const result = stealthyRequire.apply(this, arguments)

    return result
  })
})
function restoreCache (origin, target) {
  Object.entries(origin).forEach(([file, cache]) => {
    target[file] = cache
  })
}
