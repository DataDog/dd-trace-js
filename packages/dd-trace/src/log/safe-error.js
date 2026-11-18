'use strict'

/**
 * An error whose message telemetry sends instead of redacting it. Nothing checks the message, so only use it when the
 * whole message, including every value it interpolates, is certain to contain no customer data.
 */
class SafeError extends Error {}

module.exports = SafeError
