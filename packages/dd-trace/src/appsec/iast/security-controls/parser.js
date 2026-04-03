'use strict'

const log = require('../../../log')
const { getMarkFromVulnerabilityType, CUSTOM_SECURE_MARK } = require('../taint-tracking/secure-marks')

const SECURITY_CONTROL_DELIMITER = ';'
const SECURITY_CONTROL_FIELD_DELIMITER = ':'
const SECURITY_CONTROL_ELEMENT_DELIMITER = ','

const INPUT_VALIDATOR_TYPE = 'INPUT_VALIDATOR'
const SANITIZER_TYPE = 'SANITIZER'

const validTypes = new Set([INPUT_VALIDATOR_TYPE, SANITIZER_TYPE])

/**
 * @param {string} securityControlsConfiguration
 * @returns {Map<string, Array<{
 *   type: string,
 *   secureMarks: number,
 *   file: string,
 *   method: string,
 *   parameters: number[] | undefined
 * }>>}
 */
function parse (securityControlsConfiguration) {
  const controls = new Map()

  const potentialControls = securityControlsConfiguration
    .replaceAll(/[\r\n\t\v\f]*/g, '')
    .split(SECURITY_CONTROL_DELIMITER)

  for (const potentialControl of potentialControls) {
    const control = parseControl(potentialControl)
    if (control) {
      const fileControls = controls.get(control.file)
      if (fileControls) {
        fileControls.push(control)
      } else {
        controls.set(control.file, [control])
      }
    }
  }

  return controls
}

/**
 * @param {string} control
 * @returns {{
 *   type: string,
 *   secureMarks: number,
 *   file: string,
 *   method: string,
 *   parameters: number[] | undefined
 * } | undefined}
 */
function parseControl (control) {
  if (!control) return

  const fields = control.split(SECURITY_CONTROL_FIELD_DELIMITER)

  if (fields.length < 3 || fields.length > 5) {
    log.warn('[ASM] Security control configuration is invalid: %s', control)
    return
  }

  let [type, marks, file, method, parameters] = fields

  type = type.trim().toUpperCase()
  if (!validTypes.has(type)) {
    log.warn('[ASM] Invalid security control type: %s', type)
    return
  }

  let secureMarks = CUSTOM_SECURE_MARK
  for (const mark of getSecureMarks(marks)) {
    secureMarks |= mark
  }
  if (secureMarks === CUSTOM_SECURE_MARK) {
    log.warn('[ASM] Invalid security control mark: %s', marks)
    return
  }

  file = file.trim()

  method = method?.trim()

  try {
    const parsedParameters = getParameters(parameters)
    return { type, secureMarks, file, method, parameters: parsedParameters }
  } catch {
    log.warn('[ASM] Invalid non-numeric security control parameter %s', parameters)
  }
}

/**
 * @param {string} marks
 * @returns {number[]}
 */
function getSecureMarks (marks) {
  return marks.split(SECURITY_CONTROL_ELEMENT_DELIMITER)
    .map(getMarkFromVulnerabilityType)
    .filter(Boolean)
}

/**
 * @param {string | undefined} parameters
 */
function getParameters (parameters) {
  return parameters?.split(SECURITY_CONTROL_ELEMENT_DELIMITER)
    .map(param => {
      const parsedParam = Number.parseInt(param, 10)

      // discard the securityControl if there is an incorrect parameter
      if (Number.isNaN(parsedParam)) {
        throw new TypeError('Invalid non-numeric security control parameter')
      }

      return parsedParam
    })
}

module.exports = {
  parse,

  INPUT_VALIDATOR_TYPE,
  SANITIZER_TYPE,
}
