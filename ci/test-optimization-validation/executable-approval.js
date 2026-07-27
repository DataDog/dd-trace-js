'use strict'

const APPROVED_EXECUTABLE = Symbol('approvedValidationExecutable')

/**
 * Binds a command to the executable identity covered by the approved plan.
 *
 * @param {object} command command to bind
 * @param {object} identity approved executable identity
 * @returns {void}
 */
function bindApprovedExecutable (command, identity) {
  Object.defineProperty(command, APPROVED_EXECUTABLE, {
    configurable: true,
    enumerable: false,
    value: identity,
    writable: false,
  })
}

/**
 * Returns the executable identity bound to a command.
 *
 * @param {object} command command to inspect
 * @returns {object|undefined} approved executable identity
 */
function getApprovedExecutable (command) {
  return command?.[APPROVED_EXECUTABLE]
}

/**
 * Carries an approved executable identity onto a derived command.
 *
 * @param {object} source source command
 * @param {object} derived derived command
 * @returns {object} derived command
 */
function inheritApprovedExecutable (source, derived) {
  const identity = getApprovedExecutable(source)
  if (identity && source !== derived) bindApprovedExecutable(derived, identity)
  return derived
}

module.exports = {
  bindApprovedExecutable,
  getApprovedExecutable,
  inheritApprovedExecutable,
}
