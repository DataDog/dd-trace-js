'use strict'

const dns = require('dns')
const util = require('util')

const { DD_MAJOR } = require('../../../../version')
const { parsers, transformers, telemetryTransformers, setWarnInvalidValue } = require('./parsers')
const {
  supportedConfigurations,
} = /** @type {import('./helper').SupportedConfigurationsJson} */ (require('./supported-configurations.json'))

let log
let seqId = 0
const configWithOrigin = new Map()
const parseErrors = new Map()

if (DD_MAJOR >= 6) {
  // Programmatic configuration of DD_IAST_SECURITY_CONTROLS_CONFIGURATION is not supported
  // in newer major versions. This is special handled here until a better solution is found.
  // TODO: Remove the programmatic configuration from supported-configurations.json once v5 is not supported anymore.
  supportedConfigurations.DD_IAST_SECURITY_CONTROLS_CONFIGURATION[0].internalPropertyName =
    supportedConfigurations.DD_IAST_SECURITY_CONTROLS_CONFIGURATION[0].configurationNames?.[0]
  delete supportedConfigurations.DD_IAST_SECURITY_CONTROLS_CONFIGURATION[0].configurationNames
} else {
  // Default value for DD_TRACE_STARTUP_LOGS is 'false' in older major versions.
  // This is special handled here until a better solution is found.
  // TODO: Remove this here once v5 is not supported anymore.
  supportedConfigurations.DD_TRACE_STARTUP_LOGS[0].default = 'false'
}

/**
 * Warns about an invalid value for an option and adds the error to the last telemetry entry if it is not already set.
 * Logging happens only if the error is not already set or the option name is different from the last telemetry entry.
 *
 * @param {unknown} value - The value that is invalid.
 * @param {string} optionName - The name of the option.
 * @param {string} source - The source of the value.
 * @param {string} baseMessage - The base message to use for the warning.
 * @param {Error} [error] - An error that was thrown while parsing the value.
 */
function warnInvalidValue (value, optionName, source, baseMessage, error) {
  const canonicalName = (optionsTable[optionName]?.canonicalName ?? optionName) + source
  // Lazy load log module to avoid circular dependency
  if (!parseErrors.has(canonicalName)) {
    // TODO: Rephrase: It will fallback to former source (or default if not set)
    let message = `${baseMessage}: ${util.inspect(value)} for ${optionName} (source: ${source}), picked default`
    if (error) {
      error.stack = error.toString()
      message += `\n\n${util.inspect(error)}`
    }
    parseErrors.set(canonicalName, { message })
    log ??= require('../log')
    const logLevel = error ? 'error' : 'warn'
    log[logLevel](message)
  }
}
setWarnInvalidValue(warnInvalidValue)

/** @type {import('./config-types').ConfigDefaults} */
const defaults = {
  instrumentationSource: 'manual',
  isServiceUserProvided: false,
  isServiceNameInferred: true,
  plugins: true,
  isCiVisibility: false,
  lookup: dns.lookup,
  logger: undefined,
}

for (const [name, value] of Object.entries(defaults)) {
  configWithOrigin.set(`${name}default`, {
    name,
    value: value ?? null,
    origin: 'default',
    seq_id: seqId++,
  })
}

/**
 * @param {unknown} value
 * @param {string} origin
 * @param {string} optionName
 */
function generateTelemetry (value = null, origin, optionName) {
  const { type, canonicalName = optionName } = configurationsTable[optionName] ?? { type: typeof value }
  // TODO: Consider adding a preParser hook to the parsers object.
  if (canonicalName === 'OTEL_RESOURCE_ATTRIBUTES') {
    value = telemetryTransformers.MAP(value)
  }
  // TODO: Should we not send defaults to telemetry to reduce size?
  // TODO: How to handle aliases/actual names in the future? Optional fields? Normalize the name at intake?
  // TODO: Validate that space separated tags are parsed by the backend. Optimizations would be possible with that.
  // TODO: How to handle telemetry reporting for aliases?
  if (value !== null) {
    if (telemetryTransformers[type]) {
      value = telemetryTransformers[type](value)
    } else if (typeof value === 'object' && value !== null) {
      value = value instanceof URL
        ? String(value)
        : JSON.stringify(value)
    } else if (typeof value === 'function') {
      value = value.name || 'function'
    }
  }
  const telemetryEntry = {
    name: canonicalName,
    value,
    origin,
    seq_id: seqId++,
  }
  const error = parseErrors.get(`${canonicalName}${origin}`)
  if (error) {
    parseErrors.delete(`${canonicalName}${origin}`)
    telemetryEntry.error = error
  }
  configWithOrigin.set(`${canonicalName}${origin}`, telemetryEntry)
}

// Iterate over the object and always handle the leaf properties as lookup.
// Example entries:
//
// cloudPayloadTagging: {
//   nestedProperties: [
//     'rules',
//     'requestsEnabled',
//     'responses',
//   ],
//   option: {
//     property: 'rules',
//     parser: parsers.JSON,
//     canonicalName: 'DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING',
//     transformer: transformers.toCamelCase,
//   },
// },
// 'cloudPayloadTagging.responses': {
//   nestedProperties: [
//     'enabled',
//   ],
// },
// 'cloudPayloadTagging.rules': {},
// 'cloudPayloadTagging.requestsEnabled': {},
// 'cloudPayloadTagging.responses.enabled': {}
const optionsTable = {
  // Additional properties that are not supported by the supported-configurations.json file.
  lookup: {
    transformer (value) {
      if (typeof value === 'function') {
        return value
      }
    },
    property: 'lookup',
  },
  logger: {
    transformer (object) {
      // Create lazily to avoid the overhead when not used.
      // Match at least one log level.
      const knownLogLevels = new Set(supportedConfigurations.DD_TRACE_LOG_LEVEL[0].allowed?.split('|'))
      if (typeof object !== 'object' || object === null) {
        return object
      }
      let matched = false
      for (const logLevel of knownLogLevels) {
        if (object[logLevel] !== undefined) {
          if (typeof object[logLevel] !== 'function') {
            warnInvalidValue(object[logLevel], 'logger', 'default', `Invalid log level ${logLevel}`)
            return
          }
          matched = true
        }
      }
      if (matched) {
        return object
      }
    },
    property: 'logger',
  },
  isCiVisibility: {
    property: 'isCiVisibility',
  },
  plugins: {
    property: 'plugins',
  },
}

const parser = (value, optionName, source) => {
  const { type, canonicalName = optionName } = configurationsTable[optionName]
  const parsed = parsers[type](value, canonicalName)
  if (parsed === undefined) {
    warnInvalidValue(value, optionName, source, `Invalid ${type} input`)
  }
  return parsed
}

/**
 * @template {import('./config-types').ConfigPath} TPath
 * @type {Partial<Record<TPath, {
 *   property?: string,
 *   parser: (value: unknown, optionName: string, source: string) => unknown,
 *   canonicalName?: string,
 *   transformer?: (value: unknown, optionName: string, source: string) => unknown,
 *   telemetryTransformer?: (value: unknown) => unknown
 * }>>} ConfigurationsTable
 */
const configurationsTable = {}

// One way aliases. Must be applied in apply calculated entries.
const fallbackConfigurations = new Map()

const regExps = {}

for (const [canonicalName, entries] of Object.entries(supportedConfigurations)) {
  if (entries.length !== 1) {
    // TODO: Determine if we really want to support multiple entries for a canonical name.
    // This would be needed to show official support for multiple diverging implementations
    // at a time with by checking for another configuration that is not the canonical name.
    throw new Error(
      `Multiple entries found for canonical name: ${canonicalName}. ` +
      'This is currently not supported and must be implemented, if needed.'
    )
  }
  for (const entry of entries) {
    const configurationNames = entry.internalPropertyName ? [entry.internalPropertyName] : entry.configurationNames
    const fullPropertyName = configurationNames?.[0] ?? canonicalName
    const type = entry.type.toUpperCase()

    let transformer = transformers[entry.transform]
    if (entry.allowed) {
      regExps[entry.allowed] ??= new RegExp(`^(${entry.allowed})$`, 'i')
      const allowed = regExps[entry.allowed]
      const originalTransform = transformer
      transformer = (value, optionName, source) => {
        if (!allowed.test(value)) {
          warnInvalidValue(value, optionName, source, 'Invalid value')
          return
        }
        if (originalTransform) {
          value = originalTransform(value)
        }
        return value
      }
    }

    const option = { parser, type }

    if (fullPropertyName !== canonicalName) {
      option.property = fullPropertyName
      option.canonicalName = canonicalName
      configurationsTable[fullPropertyName] = option
    }
    if (transformer) {
      option.transformer = transformer
    }
    if (entry.configurationNames) {
      addOption(option, type, entry.configurationNames)
    }
    configurationsTable[canonicalName] = option

    if (entry.default === null) {
      defaults[fullPropertyName] = undefined
    } else {
      let parsedDefault = parser(entry.default, fullPropertyName, 'default')
      if (entry.transform) {
        parsedDefault = transformer(parsedDefault, fullPropertyName, 'default')
      }
      defaults[fullPropertyName] = parsedDefault
    }
    generateTelemetry(defaults[fullPropertyName], 'default', fullPropertyName)

    if (entry.aliases) {
      for (const alias of entry.aliases) {
        if (!supportedConfigurations[alias]) {
          // An actual alias has no matching entry
          continue
        }
        if (!supportedConfigurations[alias].aliases?.includes(canonicalName)) {
          // Alias will be replaced with the full property name of the alias, if it exists.
          fallbackConfigurations.set(fullPropertyName, alias)
        }
      }
    }
  }
}

// Replace the alias with the canonical property name.
for (const [fullPropertyName, alias] of fallbackConfigurations) {
  if (configurationsTable[alias].property) {
    fallbackConfigurations.set(fullPropertyName, configurationsTable[alias].property)
  }
}

function addOption (option, type, configurationNames) {
  for (const name of configurationNames) {
    let index = -1
    let lastNestedProperties
    while (true) {
      const nextIndex = name.indexOf('.', index + 1)
      const intermediateName = nextIndex === -1 ? name : name.slice(0, nextIndex)
      if (lastNestedProperties) {
        lastNestedProperties.add(intermediateName.slice(index + 1))
      }

      if (nextIndex === -1) {
        if (optionsTable[name]) {
          if (optionsTable[name].nestedProperties && !optionsTable[name].option) {
            optionsTable[name].option = option
            break
          }
          throw new Error(`Duplicate configuration name: ${name}`)
        }
        optionsTable[name] = option
        break
      }

      lastNestedProperties = new Set()
      index = nextIndex

      if (!optionsTable[intermediateName]) {
        optionsTable[intermediateName] = {
          nestedProperties: lastNestedProperties,
        }
      } else if (optionsTable[intermediateName].nestedProperties) {
        lastNestedProperties = optionsTable[intermediateName].nestedProperties
      } else {
        optionsTable[intermediateName] = {
          nestedProperties: lastNestedProperties,
          option: optionsTable[intermediateName],
        }
      }
    }
  }
}

module.exports = {
  configurationsTable,

  defaults,

  fallbackConfigurations,

  optionsTable,

  configWithOrigin,

  parseErrors,

  generateTelemetry,
}
