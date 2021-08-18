'use strict'

const parse = require('module-details-from-path')

const iitm = require('import-in-the-middle')

function esmHook (instrumentedModules, hookFn) {
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

module.exports = esmHook
