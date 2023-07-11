'use strict'

const Verbosity = {
  OFF: 0,
  MANDATORY: 1,
  INFORMATION: 2,
  DEBUG: 3
}

function isDebugAllowed (value) {
  return value >= Verbosity.DEBUG
}

function isInfoAllowed (value) {
  return value >= Verbosity.INFORMATION
}

function getVerbosity (verbosity) {
  if (verbosity) {
    verbosity = verbosity.toUpperCase()
    return Verbosity[verbosity] !== undefined ? Verbosity[verbosity] : Verbosity.INFORMATION
  } else {
    return Verbosity.INFORMATION
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
