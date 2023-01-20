'use strict'

const Verbosity = {
  OFF: 0,
  MANDATORY: 1,
  INFORMATION: 2,
  DEBUG: 3
}

const telemetryVerbosity = process.env.DD_IAST_TELEMETRY_VERBOSITY
  ? getVerbosity(process.env.DD_IAST_TELEMETRY_VERBOSITY, true)
  : Verbosity.INFORMATION

function isDebugAllowed (value) {
  return value >= Verbosity.DEBUG
}

function isInfoAllowed (value) {
  return value >= Verbosity.INFORMATION
}

function getVerbosity (verbosity, initialization) {
  if (verbosity) {
    verbosity = verbosity.toUpperCase()
    return Verbosity[verbosity] !== undefined ? Verbosity[verbosity]
      : initialization ? Verbosity.INFORMATION : telemetryVerbosity
  } else {
    return telemetryVerbosity
  }
}

function getName (verbosityValue) {
  for (const name in Verbosity) {
    if (Verbosity[name] === verbosityValue) {
      return name
    }
  }
  return 'OFF'
}

module.exports = {
  Verbosity,
  isDebugAllowed,
  isInfoAllowed,
  getVerbosity,
  getName
}
