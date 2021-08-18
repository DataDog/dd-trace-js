'use strict'

const parse = require('module-details-from-path')

let iitm

function esmHook (instrumentedModules, hookFn) {
  if (!iitm) {
    import('import-in-the-middle').then(iitmModule => {
      iitm = iitmModule
      esmHook(instrumentedModules, hookFn)
    }, (_err) => {
      // ESM isn't supported
      // TODO log this in debug mode?
      iitm = { enabled: () => false }
    })
    return
  }

  if (!iitm.enabled()) {
    return
  }

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
        const newDefault = hookFn(namespace, moduleName, baseDir)
        if (newDefault) {
          namespace.default = newDefault
        }
      }
    }
  })
}

module.exports = esmHook
