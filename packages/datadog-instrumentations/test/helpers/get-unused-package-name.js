'use strict'

/**
 * @param {Iterable<string>} names
 */
function getUnusedPackageName (names) {
  const usedNames = new Set(names)
  let name = 'unused-package'
  while (usedNames.has(name)) name = `unused-${name}`
  return name
}

module.exports = { getUnusedPackageName }
