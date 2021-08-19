'use strict'

const semver = require('semver')

if (semver.satisfies(process.versions.node, '^12.20.0 || >=14.13.1')) {
  const parse = require('module-details-from-path')

  const iitm = require('import-in-the-middle')

  module.exports = function esmHook (instrumentedModules, hookFn) {
    iitm.addHook((name, namespace) => {
      const isBuiltin = name.startsWith('node:')
      let baseDir

      if (isBuiltin) {
        name = name.replace(/^node:/, '')
      } else {
        name = name.replace('file://', '')
        const details = parse(name)
        if (details) {
          name = details.name
          baseDir = details.basedir
        }
      }

      for (const moduleName of instrumentedModules) {
        if (moduleName === name) {
          const newDefault = hookFn(namespace, moduleName, baseDir, true)
          if (newDefault) {
            namespace.default = newDefault
          }
        }
      }
    })
  }
} else {
  // ESM not properly supported by this version of node.js
  module.exports = () => {}
}
