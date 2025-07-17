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
  if (nm === -1) {
    return { pkg: null, path: null }
  }

  const subPath = fullPath.slice(nm + NM.length)
  const firstSlash = subPath.indexOf('/')

  const firstPath = fullPath.slice(0, nm + NM.length)

  const firstSlashSubPath = subPath.slice(Math.max(0, firstSlash + 1))

  if (subPath[0] === '@') {
    const secondSlash = firstSlashSubPath.indexOf('/')
    const pkg = subPath.slice(0, Math.max(0, firstSlash + 1 + secondSlash))

    return {
      pkg,
      path: subPath.slice(Math.max(0, firstSlash + 1 + secondSlash + 1)),
      pkgJson: firstPath + pkg + '/package.json'
    }
  }

  const pkg = subPath.slice(0, Math.max(0, firstSlash))

  return {
    pkg,
    path: firstSlashSubPath,
    pkgJson: firstPath + pkg + '/package.json'
  }
}
