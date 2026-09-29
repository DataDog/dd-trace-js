'use strict'

const log = require('../log')

// Set by the SDK so a consumer can tell a hand-declared manifest from one read off a framework object.
const MANUAL_FRAMEWORK_NAME = 'manual'

// Provider-specific keys such as `extra_headers` can carry secrets, so only these are reported.
const ALLOWED_MODEL_SETTINGS_KEYS = new Set([
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'max_tokens',
  'parallel_tool_calls',
  'presence_penalty',
  'seed',
  'stop_sequences',
  'temperature',
  'timeout',
  'tool_choice',
  'top_k',
  'top_logprobs',
  'top_p',
])

const LABEL_FIELDS = ['name', 'instructions', 'model']

/**
 * @typedef {{ type?: string, required?: true }} AgentToolParameter
 * @typedef {{ name: string, description?: string, parameters?: Record<string, AgentToolParameter> }} AgentTool
 * @typedef {{
 *   name?: string,
 *   instructions?: string,
 *   model?: string,
 *   model_settings?: Record<string, unknown>,
 *   tools?: AgentTool[],
 * }} AgentManifestFields
 * @typedef {{ version?: string, manifest?: AgentManifestFields }} AgentDeclaration
 */

/**
 * Reads the agent a caller declared through `annotate({ agent })` or `annotationContext({ agent })` into an
 * immutable snapshot. Never throws, since the caller's object may carry throwing getters or be a revoked Proxy,
 * and this runs while an LLMObs span is being registered.
 *
 * @param {unknown} agent
 * @returns {AgentDeclaration | undefined} undefined when the agent declares nothing reportable
 */
function buildAgentDeclaration (agent) {
  let declaration
  try {
    if (isPlainObject(agent)) {
      const version = toAgentVersion(agent.version)
      const manifest = buildAgentManifest(agent)
      if (version !== undefined || manifest !== undefined) declaration = { version, manifest }
    } else {
      log.warn('Dropping agent annotation, the agent must be a plain object.')
    }
  } catch {
    log.warn('Dropping agent annotation, its fields could not be read.')
  }
  return declaration
}

/**
 * Validates each manifest field on its own, so one bad field cannot blank the rest. Unset values (`undefined`,
 * `null`, `''`, `[]`, `{}`) are omitted so they declare nothing rather than erase an earlier declaration. Fields
 * that are set but unreportable are dropped and logged by name, never by value.
 *
 * @param {Record<string, unknown>} agent
 * @returns {AgentManifestFields | undefined}
 */
function buildAgentManifest (agent) {
  /** @type {string[]} */
  const dropped = []
  /** @type {AgentManifestFields | undefined} */
  let manifest

  for (const key of LABEL_FIELDS) {
    const value = agent[key]
    if (isUnset(value)) continue
    if (typeof value === 'string') {
      manifest ??= {}
      manifest[key] = value
    } else {
      dropped.push(key)
    }
  }

  const modelSettings = buildModelSettings(agent.modelSettings, dropped)
  if (modelSettings) {
    manifest ??= {}
    manifest.model_settings = modelSettings
  }

  const tools = buildTools(agent.tools, dropped)
  if (tools) {
    manifest ??= {}
    manifest.tools = tools
  }

  if (dropped.length > 0) {
    log.warn('Dropping unsupported agent manifest fields: %s', dropped.join(', '))
  }

  return manifest
}

/**
 * @param {unknown} version
 */
function toAgentVersion (version) {
  return typeof version === 'string' && version !== '' ? version : undefined
}

/**
 * @param {unknown} settings
 * @param {string[]} dropped
 * @returns {Record<string, unknown> | undefined}
 */
function buildModelSettings (settings, dropped) {
  if (isUnset(settings)) return
  if (!isPlainObject(settings)) {
    dropped.push('modelSettings')
    return
  }

  let allowed
  for (const [key, value] of Object.entries(settings)) {
    const wireKey = toSnakeCase(key)
    if (!ALLOWED_MODEL_SETTINGS_KEYS.has(wireKey)) {
      dropped.push(`modelSettings.${key}`)
      continue
    }
    if (isUnset(value)) continue
    const wireValue = toFlatScalarValue(value)
    if (wireValue === null) continue
    if (wireValue === undefined) {
      dropped.push(`modelSettings.${key}`)
      continue
    }
    allowed ??= {}
    allowed[wireKey] = wireValue
  }
  return allowed
}

/**
 * A JSON scalar, a flat array of scalars, or a flat object of numbers (`logit_bias`). No allowed setting nests, so
 * anything deeper is dropped rather than coerced. Returns undefined for a value that cannot be reported, and null
 * for an empty object, which declares nothing.
 *
 * @param {unknown} value
 */
function toFlatScalarValue (value) {
  if (isScalar(value)) return value
  if (Array.isArray(value)) {
    const items = [...value]
    for (const item of items) {
      if (!isScalar(item)) return
    }
    return items
  }
  if (!isPlainObject(value)) return

  const entries = Object.entries(value)
  if (entries.length === 0) return null
  for (const [, item] of entries) {
    if (!isFiniteNumber(item)) return
  }
  // Built from entries so a key such as `__proto__` becomes an own property rather than setting the prototype.
  return Object.fromEntries(entries)
}

/**
 * @param {unknown} declared
 * @param {string[]} dropped
 * @returns {AgentTool[] | undefined}
 */
function buildTools (declared, dropped) {
  if (isUnset(declared)) return
  if (!Array.isArray(declared)) {
    dropped.push('tools')
    return
  }

  const tools = []
  for (let index = 0; index < declared.length; index++) {
    const tool = declared[index]
    const name = isPlainObject(tool) ? tool.name : undefined
    // An unnamed tool is unidentifiable once it ships.
    if (typeof name !== 'string' || name === '') {
      dropped.push(`tools[${index}]`)
      continue
    }

    /** @type {AgentTool} */
    const built = { name }
    const description = tool.description
    if (typeof description === 'string' && description !== '') built.description = description
    const parameters = buildToolParameters(tool.parameters)
    if (parameters === null) {
      dropped.push(`tools[${index}].parameters`)
    } else if (parameters) {
      built.parameters = parameters
    }
    tools.push(built)
  }
  return tools.length > 0 ? tools : undefined
}

/**
 * Flattens tool parameters to `{ param: { type?, required? } }`, the shape the Python framework integrations emit.
 * `required` is omitted rather than reported false. Returns null for parameters that are set but not a plain
 * object, such as a schema-library instance, so the caller can report them as dropped.
 *
 * @param {unknown} parameters
 * @returns {Record<string, AgentToolParameter> | null | undefined}
 */
function buildToolParameters (parameters) {
  if (isUnset(parameters)) return
  if (!isPlainObject(parameters)) return null

  const { specs, required } = toolParameterSpecs(parameters)
  const flattened = []
  for (const [param, spec] of Object.entries(specs)) {
    /** @type {AgentToolParameter} */
    const entry = {}
    if (isPlainObject(spec)) {
      const { type } = spec
      if (typeof type === 'string' && type !== '') entry.type = type
      if (spec.required === true) entry.required = true
    }
    if (required?.has(param)) entry.required = true
    if (entry.type === undefined && entry.required === undefined) continue
    flattened.push([param, entry])
  }
  // Built from entries so a parameter named `__proto__` becomes an own property rather than setting the prototype.
  return flattened.length > 0 ? Object.fromEntries(flattened) : undefined
}

/**
 * Accepts a JSON Schema object as well as the documented `{ param: { type, required } }` mapping, since a JSON
 * Schema is what OpenAI, Gemini and MCP tool definitions carry. Two markers are required rather than `properties`
 * alone, so a mapping that declares a parameter named `properties` is still read as a mapping.
 *
 * @param {Record<string, unknown>} parameters
 * @returns {{ specs: Record<string, unknown>, required?: Set<unknown> }}
 */
function toolParameterSpecs (parameters) {
  const { properties, required } = parameters
  const hasRequiredList = Array.isArray(required)
  if (!isPlainObject(properties) || !(parameters.type === 'object' || hasRequiredList)) {
    return { specs: parameters }
  }
  return { specs: properties, required: hasRequiredList ? new Set(required) : undefined }
}

/**
 * @param {string} key
 */
function toSnakeCase (key) {
  return key.replaceAll(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

/**
 * Class instances are rejected so a schema-library object (Zod, the AI SDK `jsonSchema()` wrapper) is dropped rather
 * than read field by field into a misleading manifest.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject (value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * @param {unknown} value
 */
function isUnset (value) {
  if (value === undefined || value === null || value === '') return true
  return Array.isArray(value) && value.length === 0
}

/**
 * @param {unknown} value
 */
function isFiniteNumber (value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * @param {unknown} value
 */
function isScalar (value) {
  return typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value)
}

module.exports = {
  MANUAL_FRAMEWORK_NAME,
  buildAgentDeclaration,
  toAgentVersion,
}
