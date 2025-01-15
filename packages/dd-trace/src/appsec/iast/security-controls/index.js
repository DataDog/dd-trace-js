'use strict'

const path = require('path')
const { storage } = require('../../../../../datadog-core')
const Hook = require('../../../../../datadog-instrumentations/src/helpers/hook')
const shimmer = require('../../../../../datadog-shimmer')
const log = require('../../../log')
const { parse, SANITIZER_TYPE } = require('./parser')
const TaintTrackingOperations = require('../taint-tracking/operations')
const { getIastContext } = require('../iast-context')

let hooks

function configure (iastConfig) {
  if (!iastConfig?.securityControlsConfiguration) return

  hooks = []

  parse(iastConfig.securityControlsConfiguration)
    .forEach(hook)
}

function hook (controlsByFile, file) {
  try {
    // FIXME: ESM modules?
    // TODO: node_modules
    const fileName = require.resolve(path.join(process.cwd(), file))

    const hooked = Hook([fileName], undefined, (moduleExports) => {
      controlsByFile.forEach(({ type, method, parameters, secureMarks }) => {
        const { target, parent, name } = resolve(method, moduleExports)
        if (!target) {
          log.error('Unable to resolve IAST security control %s:%s', file, method)
          return
        }

        if (type === SANITIZER_TYPE) {
          parent[name] = wrapSanitizer(target, secureMarks)
        } else {
          parent[name] = wrapInputValidator(target, parameters, secureMarks)
        }
      })

      return moduleExports
    })

    hooks.push(hooked)

    // TODO: is this catch needed?
  } catch (e) {
    log.error('Error initializing IAST security control for %', file, e)
  }
}

function resolve (path, obj, separator = '.') {
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
  hooks?.forEach(hook => hook?.unhook())
  hooks = undefined
}

module.exports = {
  configure,
  disable
}
