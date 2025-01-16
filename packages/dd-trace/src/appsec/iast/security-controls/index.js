'use strict'

const path = require('path')
const dc = require('dc-polyfill')
const { storage } = require('../../../../../datadog-core')
const shimmer = require('../../../../../datadog-shimmer')
const log = require('../../../log')
const { parse, SANITIZER_TYPE } = require('./parser')
const TaintTrackingOperations = require('../taint-tracking/operations')
const { getIastContext } = require('../iast-context')
const { iterateObjectStrings } = require('../utils')

// esm
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

// cjs
const moduleLoadEndChannel = dc.channel('dd-trace:moduleLoadEnd')

let controls
let hooks

function configure (iastConfig) {
  if (!iastConfig?.securityControlsConfiguration) return

  hooks = []
  controls = parse(iastConfig.securityControlsConfiguration)

  moduleLoadStartChannel.subscribe(onModuleLoaded)
  moduleLoadEndChannel.subscribe(onModuleLoaded)
}

function onModuleLoaded (payload) {
  if (!payload?.module) return

  const { filename, module } = payload

  const controlsByFile = getControls(filename)
  if (controlsByFile) {
    payload.module = hookModule(filename, module, controlsByFile)
  }
}

function getControls (filename) {
  let key
  if (filename.includes('node_modules')) {
    key = [...controls.keys()].find(file => filename.endsWith(file))
  } else {
    key = path.isAbsolute(filename) ? path.relative(process.cwd(), filename) : filename
  }
  return controls.get(key)
}

function hookModule (filename, module, controlsByFile) {
  try {
    controlsByFile.forEach(({ type, method, parameters, secureMarks }) => {
      const { target, parent, methodName } = resolve(method, module)
      if (!target) {
        log.error('Unable to resolve IAST security control %s:%s', filename, method)
        return
      }

      let wrapper
      if (type === SANITIZER_TYPE) {
        wrapper = wrapSanitizer(target, secureMarks)
      } else {
        wrapper = wrapInputValidator(target, parameters, secureMarks)
      }

      if (methodName) {
        parent[methodName] = wrapper
      } else {
        module = wrapper
      }
    })
  } catch (e) {
    log.error('Error initializing IAST security control for %', filename, e)
  }

  return module
}

function resolve (path, obj, separator = '.') {
  if (!path) {
    return { target: obj, parent: obj }
  }

  const properties = path.split(separator)

  let parent
  let methodName
  const target = properties.reduce((prev, curr) => {
    parent = prev
    methodName = curr
    return prev?.[curr]
  }, obj)

  return { target, parent, methodName }
}

function wrapSanitizer (target, secureMarks) {
  return shimmer.wrapFunction(target, orig => function () {
    const result = orig.apply(this, arguments)

    try {
      return addSecureMarks(result, secureMarks)
    } catch (e) {
      log.error('Error adding Secure mark for sanitizer', e)
    }

    return result
  })
}

function wrapInputValidator (target, parameters, secureMarks) {
  const allParameters = !parameters?.length

  return shimmer.wrapFunction(target, orig => function () {
    try {
      [...arguments].forEach((arg, index) => {
        if (allParameters || parameters.includes(index)) {
          addSecureMarks(arg, secureMarks, false)
        }
      })
    } catch (e) {
      log.error('Error adding Secure mark for input validator', e)
    }

    return orig.apply(this, arguments)
  })
}

function addSecureMarks (value, secureMarks, createNewTainted = true) {
  if (!value) return

  const store = storage.getStore()
  const iastContext = getIastContext(store)

  if (typeof value === 'string') {
    return TaintTrackingOperations.addSecureMark(iastContext, value, secureMarks, createNewTainted)
  } else {
    iterateObjectStrings(value, (value, levelKeys, parent, lastKey) => {
      try {
        const securedTainted = TaintTrackingOperations.addSecureMark(iastContext, value, secureMarks, createNewTainted)
        if (createNewTainted) {
          parent[lastKey] = securedTainted
        }
      } catch (e) {
        // if it is a readonly property, do nothing
      }
    })
    return value
  }
}

function disable () {
  if (moduleLoadStartChannel.hasSubscribers) moduleLoadStartChannel.unsubscribe(onModuleLoaded)
  if (moduleLoadEndChannel.hasSubscribers) moduleLoadEndChannel.unsubscribe(onModuleLoaded)

  controls = undefined
  hooks?.forEach(hook => hook?.unhook())
  hooks = undefined
}

module.exports = {
  configure,
  disable
}
