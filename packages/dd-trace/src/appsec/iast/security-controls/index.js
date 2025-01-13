'use strict'

const path = require('path')
const { storage } = require('../../../../../datadog-core')
const Hook = require('../../../../../datadog-instrumentations/src/helpers/hook')
const shimmer = require('../../../../../datadog-shimmer')
const log = require('../../../log')
const { parse, SANITIZER_TYPE } = require('./parser')
const TaintTrackingOperations = require('../taint-tracking/operations')
const { getIastContext } = require('../iast-context')

let controls

function configure (iastConfig) {
  if (!iastConfig?.securityControlsConfiguration) return

  controls = parse(iastConfig.securityControlsConfiguration)

  for (const [key, value] of controls) {
    hook(key, value)
  }
}

function hook (file, controlsByFile) {
  try {
    // FIXME: ESM modules?
    const fileName = require.resolve(path.join(process.cwd(), file))
    Hook([fileName], { iastSecurityControl: true }, (moduleExports) => {
      controlsByFile.forEach(({ type, method, parameters, secureMarks }) => {
        // FIXME nested object methods
        if (!moduleExports[method]) return

        if (type === SANITIZER_TYPE) {
          moduleExports[method] = wrapSanitizer(moduleExports[method], secureMarks)
        } else {
          moduleExports[method] = wrapInputValidator(moduleExports[method], parameters, secureMarks)
        }
      })

      return moduleExports
    })
  } catch (e) {
    log.error('Error initializing IAST security Control for %', file, e)
  }
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

module.exports = {
  configure
}
