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
let controlsKeys
let hooks

function configure (iastConfig) {
  if (!iastConfig?.securityControlsConfiguration) return

  try {
    controls = parse(iastConfig.securityControlsConfiguration)
    if (controls?.size > 0) {
      hooks = new WeakSet()
      controlsKeys = [...controls.keys()]

      moduleLoadStartChannel.subscribe(onModuleLoaded)
      moduleLoadEndChannel.subscribe(onModuleLoaded)
    }
  } catch (e) {
    log.error('[ASM] Error configuring IAST Security Controls', e)
  }
}

function onModuleLoaded (payload) {
  if (!payload?.module || hooks?.has(payload.module)) return

  const { filename, module } = payload

  const controlsByFile = getControls(filename)
  if (controlsByFile) {
    const hook = hookModule(filename, module, controlsByFile)
    payload.module = hook
    hooks.add(hook)
  }
}

function getControls (filename) {
  if (filename.startsWith('file://')) {
    filename = filename.substring(7)
  }

  let key = path.isAbsolute(filename) ? path.relative(process.cwd(), filename) : filename
  key = key.replaceAll(path.sep, path.posix.sep)

  if (key.includes('node_modules')) {
    key = controlsKeys.find(file => key.endsWith(file))
  }

  return controls.get(key)
}

function hookModule (filename, module, controlsByFile) {
  try {
    controlsByFile.forEach(({ type, method, parameters, secureMarks }) => {
      const { target, parent, methodName } = resolve(method, module)
      if (!target) {
        log.error('[ASM] Unable to resolve IAST security control %s:%s', filename, method)
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
    log.error('[ASM] Error initializing IAST security control for %', filename, e)
  }

  return module
}

function resolve (path, obj, separator = '.') {
  if (!path) {
    // esm module with default export
    if (obj?.default) {
      return { target: obj.default, parent: obj, methodName: 'default' }
    } else {
      return { target: obj, parent: obj }
    }
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
      log.error('[ASM] Error adding Secure mark for sanitizer', e)
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
      log.error('[ASM] Error adding Secure mark for input validator', e)
    }

    return orig.apply(this, arguments)
  })
}

function addSecureMarks (value, secureMarks, createNewTainted = true) {
  if (!value) return

  const store = storage('legacy').getStore()
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
  controlsKeys = undefined
  hooks = undefined
}

module.exports = {
  configure,
  disable
}
