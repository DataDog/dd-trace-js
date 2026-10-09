'use strict'

// The first supported protocol is also the fallback for that signal.
const httpProtocols = /** @type {const} */ (['http/protobuf', 'http/json'])
const protocols = {
  default: httpProtocols,
  traces: /** @type {const} */ (['http/json']),
  logs: httpProtocols,
  metrics: httpProtocols,
}

/**
 * Resolve a requested protocol to an encoding implemented by the signal's HTTP exporter.
 * @template {keyof typeof protocols} T
 * @param {string | undefined} protocol
 * @param {T} signal
 * @returns {(typeof protocols)[T][number]}
 */
function resolveProtocol (protocol, signal) {
  const supported = protocols[signal]
  if (protocol && /** @type {readonly string[]} */ (supported).includes(protocol)) {
    return /** @type {(typeof protocols)[T][number]} */ (protocol)
  }

  return supported[0]
}

module.exports = { resolveProtocol }
