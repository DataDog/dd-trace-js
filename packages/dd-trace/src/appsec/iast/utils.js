'use strict'

function iterateObjectStrings (target, fn, levelKeys = [], depth = 20, visited = new Set()) {
  if (target !== null && typeof target === 'object') {
    if (visited.has(target)) return

    visited.add(target)

    Object.keys(target).forEach((key) => {
      const nextLevelKeys = [...levelKeys, key]
      const val = target[key]

      if (typeof val === 'string') {
        fn(val, nextLevelKeys, target, key)
      } else if (depth > 0) {
        iterateObjectStrings(val, fn, nextLevelKeys, depth - 1, visited)
      }
    })
  }
}

module.exports = {
  iterateObjectStrings
}
