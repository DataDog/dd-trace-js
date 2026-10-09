'use strict'

const log = require('../../log')

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
 * @param {boolean} [warnUnsupported]
 * @returns {(typeof protocols)[T][number]}
 */
function resolveProtocol (protocol, signal, warnUnsupported = false) {
  const supported = protocols[signal]
  if (protocol && /** @type {readonly string[]} */ (supported).includes(protocol)) {
    return /** @type {(typeof protocols)[T][number]} */ (protocol)
  }

  if (protocol === 'grpc' && warnUnsupported) {
    log.warn(
      // eslint-disable-next-line @stylistic/max-len
      'OTLP gRPC protocol is not supported for %s. Defaulting to %s. gRPC protobuf support may be added in a future release.',
      signal, supported[0]
    )
  }
  return supported[0]
}

module.exports = { resolveProtocol }
