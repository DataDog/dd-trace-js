'use strict'

const log = require('../../../log')
const { getMarkFromVulnerabilityType, CUSTOM_SECURE_MARK } = require('../taint-tracking/secure-marks')

const SECURITY_CONTROL_DELIMITER = ';'
const SECURITY_CONTROL_FIELD_DELIMITER = ':'
const SECURITY_CONTROL_ELEMENT_DELIMITER = ','

const INPUT_VALIDATOR_TYPE = 'INPUT_VALIDATOR'
const SANITIZER_TYPE = 'SANITIZER'

const validTypes = [INPUT_VALIDATOR_TYPE, SANITIZER_TYPE]

// DD_IAST_SECURITY_CONTROLS_CONFIGURATION
function parse (securityControlsConfiguration) {
  const controls = new Map()

  securityControlsConfiguration?.replace(/\s/g, '')
    .split(SECURITY_CONTROL_DELIMITER)
    .map(parseControl)
    .filter(control => !!control)
    .forEach(control => {
      let controlsByFile = controls.get(control.file)
      if (!controlsByFile) {
        controlsByFile = []
        controls.set(control.file, controlsByFile)
      }
      controlsByFile.push(control)
    })

  return controls
}

function parseControl (control) {
  if (!control) return

  const fields = control.split(SECURITY_CONTROL_FIELD_DELIMITER)

  if (fields.length < 3 || fields.length > 5) {
    // TODO: do we want telemetry log for these cases?
    log.warn('Security control configuration is invalid: %s', control)
    return
  }

  let [type, marks, file, method, parameters] = fields

  type = type.toUpperCase()
  if (!validTypes.includes(type)) {
    log.warn('Invalid security control type: %s', type)
    return
  }

  let secureMarks = CUSTOM_SECURE_MARK
  getSecureMarks(marks).forEach(mark => { secureMarks |= mark })
  if (secureMarks === CUSTOM_SECURE_MARK) {
    log.warn('Invalid security control mark: %s', marks)
    return
  }

  parameters = getParameters(parameters)

  // TODO: check if file is a valid path?

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
      let parsedParam = parseInt(param, 10)

      // TODO: should we discard the whole securityControl??
      if (isNaN(parsedParam)) {
        log.warn('Invalid non-numeric security control parameter %s', param)
        parsedParam = undefined
      }

      return parsedParam
    })
    .filter(param => !!param)
}

module.exports = {
  parse,

  INPUT_VALIDATOR_TYPE,
  SANITIZER_TYPE
}
