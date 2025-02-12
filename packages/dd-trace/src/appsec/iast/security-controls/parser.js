'use strict'

const log = require('../../../log')
const { getMarkFromVulnerabilityType, CUSTOM_SECURE_MARK } = require('../taint-tracking/secure-marks')

const SECURITY_CONTROL_DELIMITER = ';'
const SECURITY_CONTROL_FIELD_DELIMITER = ':'
const SECURITY_CONTROL_ELEMENT_DELIMITER = ','

const INPUT_VALIDATOR_TYPE = 'INPUT_VALIDATOR'
const SANITIZER_TYPE = 'SANITIZER'

const validTypes = [INPUT_VALIDATOR_TYPE, SANITIZER_TYPE]

function parse (securityControlsConfiguration) {
  const controls = new Map()

  securityControlsConfiguration?.replace(/[\r\n\t\v\f]*/g, '')
    .split(SECURITY_CONTROL_DELIMITER)
    .map(parseControl)
    .filter(control => !!control)
    .forEach(control => {
      if (!controls.has(control.file)) {
        controls.set(control.file, [])
      }
      controls.get(control.file).push(control)
    })

  return controls
}

function parseControl (control) {
  if (!control) return

  const fields = control.split(SECURITY_CONTROL_FIELD_DELIMITER)

  if (fields.length < 3 || fields.length > 5) {
    log.warn('[ASM] Security control configuration is invalid: %s', control)
    return
  }

  let [type, marks, file, method, parameters] = fields

  type = type.trim().toUpperCase()
  if (!validTypes.includes(type)) {
    log.warn('[ASM] Invalid security control type: %s', type)
    return
  }

  let secureMarks = CUSTOM_SECURE_MARK
  getSecureMarks(marks).forEach(mark => { secureMarks |= mark })
  if (secureMarks === CUSTOM_SECURE_MARK) {
    log.warn('[ASM] Invalid security control mark: %s', marks)
    return
  }

  file = file?.trim()

  method = method?.trim()

  try {
    parameters = getParameters(parameters)
  } catch (e) {
    log.warn('[ASM] Invalid non-numeric security control parameter %s', parameters)
    return
  }

  return { type, secureMarks, file, method, parameters }
}

function getSecureMarks (marks) {
  return marks?.split(SECURITY_CONTROL_ELEMENT_DELIMITER)
    .map(getMarkFromVulnerabilityType)
    .filter(mark => !!mark)
}

function getParameters (parameters) {
  return parameters?.split(SECURITY_CONTROL_ELEMENT_DELIMITER)
    .map(param => {
      const parsedParam = parseInt(param, 10)

      // discard the securityControl if there is an incorrect parameter
      if (isNaN(parsedParam)) {
        throw new Error('Invalid non-numeric security control parameter')
      }

      return parsedParam
    })
}

module.exports = {
  parse,

  INPUT_VALIDATOR_TYPE,
  SANITIZER_TYPE
}
