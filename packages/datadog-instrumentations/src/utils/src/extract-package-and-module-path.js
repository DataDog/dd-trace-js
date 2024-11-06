'use strict'

const NM = 'node_modules/'

/**
 * For a given full path to a module,
 *   return the package name it belongs to and the local path to the module
 *   input: '/foo/node_modules/@co/stuff/foo/bar/baz.js'
 *   output: { pkg: '@co/stuff', path: 'foo/bar/baz.js',  pkgJson: '/foo/node_modules/@co/stuff/package.json' }
 */
module.exports = function extractPackageAndModulePath (fullPath) {
  const nm = fullPath.lastIndexOf(NM)
  if (nm < 0) {
    return { pkg: null, path: null }
  }

  const subPath = fullPath.substring(nm + NM.length)
  const firstSlash = subPath.indexOf('/')

  const firstPath = fullPath.substring(fullPath[0], nm + NM.length)

  if (subPath[0] === '@') {
    const secondSlash = subPath.substring(firstSlash + 1).indexOf('/')
    return {
      pkg: subPath.substring(0, firstSlash + 1 + secondSlash),
      path: subPath.substring(firstSlash + 1 + secondSlash + 1),
      pkgJson: firstPath + subPath.substring(0, firstSlash + 1 + secondSlash) + '/package.json'
    }
  }

  return {
    pkg: subPath.substring(0, firstSlash),
    path: subPath.substring(firstSlash + 1),
    pkgJson: firstPath + subPath.substring(0, firstSlash) + '/package.json'
  }
}
