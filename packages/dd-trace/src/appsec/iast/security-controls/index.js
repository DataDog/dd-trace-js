'use strict'

const path = require('path')
const dc = require('dc-polyfill')
const { storage } = require('../../../../../datadog-core')
const shimmer = require('../../../../../datadog-shimmer')
const log = require('../../../log')
const { parse, SANITIZER_TYPE } = require('./parser')
const TaintTrackingOperations = require('../taint-tracking/operations')
const { getIastContext } = require('../iast-context')

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

  let controlsByFile
  if (filename.includes('node_modules')) {
    controlsByFile = controls.keys().find(file => filename.endsWith(file))
  } else {
    const relativeFilename = path.isAbsolute(filename) ? path.relative(process.cwd(), filename) : filename
    controlsByFile = controls.get(relativeFilename)
  }

  if (controlsByFile) {
    payload.module = hookModule(filename, module, controlsByFile)
  }
}

function hookModule (filename, module, controlsByFile) {
  try {
    controlsByFile.forEach(({ type, method, parameters, secureMarks }) => {
      const { target, parent, name } = resolve(method, module)
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

      if (name) {
        parent[name] = wrapper
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
  let name
  const target = properties.reduce((prev, curr) => {
    parent = prev
    name = curr
    return prev?.[curr]
  }, obj)

  return { target, parent, name }
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
          // TODO: addSecureMark to a existing string
          // TODO: check string properties in object arguments
          addSecureMarks(arg, secureMarks)
        }
      })
    } catch (e) {
      log.error('Error adding Secure mark for input validator', e)
    }

    return orig.apply(this, arguments)
  })
}

function addSecureMarks (value, secureMarks) {
  if (!value) return

  const store = storage.getStore()
  const iastContext = getIastContext(store)

  return TaintTrackingOperations.addSecureMark(iastContext, value, secureMarks)
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
