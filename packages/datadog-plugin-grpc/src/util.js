'use strict'

const pick = require('../../datadog-core/src/utils/src/pick')
const log = require('../../dd-trace/src/log')

/**
 * @typedef {object} ParsedMethodPath
 * @property {string} name
 * @property {string} service
 * @property {string} package
 */

// Sentinel returned by `getFilter` when the user has not configured a metadata
// filter. `addMetadataTags` short-circuits on this identity to skip the
// `metadata.getMap()` clone in the default no-filter case.
function getEmptyObject () {
  return {}
}

/**
 * gRPC method paths are stable per service definition (e.g.
 * `/pkg.Service/Method`); a service typically only has a small finite set.
 * Cache the parsed `{name, service, package}` triple by path so we skip the
 * `path.split('/')` + `serviceParts.split('.')` + `serviceParts.pop()` work
 * on every call.
 *
 * @type {Map<string, ParsedMethodPath>}
 */
const methodPathCache = new Map()

/**
 * @param {string} path
 * @returns {ParsedMethodPath}
 */
function parseMethodPath (path) {
  const methodParts = path.split('/')

  if (methodParts.length > 2) {
    const serviceParts = methodParts[1].split('.')
    return {
      name: methodParts[2],
      service: serviceParts.pop(),
      package: serviceParts.join('.'),
    }
  }

  return { name: methodParts.at(-1), service: '', package: '' }
}

module.exports = {
  getEmptyObject,

  getMethodMetadata (path, kind) {
    if (typeof path !== 'string') {
      return { path, kind, name: '', service: '', package: '' }
    }

    let parsed = methodPathCache.get(path)
    if (parsed === undefined) {
      parsed = parseMethodPath(path)
      methodPathCache.set(path, parsed)
    }

    return {
      path,
      kind,
      name: parsed.name,
      service: parsed.service,
      package: parsed.package,
    }
  },

  addMetadataTags (span, metadata, filter, type) {
    if (!metadata || typeof metadata.getMap !== 'function') return
    // Default no-op filter: skip the full metadata clone via `getMap()`.
    if (filter === getEmptyObject) return

    const values = filter(metadata.getMap())

    for (const key of Object.keys(values)) {
      span.setTag(`grpc.${type}.metadata.${key}`, values[key])
    }
  },

  // TODO: extract this to shared utils and add unit tests
  getFilter (config, filter) {
    if (typeof config[filter] === 'function') {
      return config[filter]
    }

    if (Array.isArray(config[filter])) {
      return element => pick(element, config[filter])
    }

    if (config.hasOwnProperty(filter)) {
      log.error('Expected \'%s\' to be an array or function.', filter)
    }

    return getEmptyObject
  },
}
