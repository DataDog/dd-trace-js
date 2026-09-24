'use strict'

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
 */

/**
 * Validates the manifest fields a caller declared through `annotate({ agent })` or
 * `annotationContext({ agent })`. Each field is validated on its own and unreportable values are
 * dropped, so one bad field cannot blank the rest. Unset values (`undefined`, `null`, `''`, `[]`,
 * `{}`) are omitted so they declare nothing rather than erase an earlier declaration.
 *
 * @param {unknown} agent
 * @returns {AgentManifestFields | undefined} the validated fields, or undefined when none are reportable
 */
function buildAgentManifest (agent) {
  if (!isPlainObject(agent)) return

  /** @type {AgentManifestFields} */
  const manifest = {}
  let hasField = false

  for (const key of ['name', 'instructions', 'model']) {
    const value = agent[key]
    if (typeof value === 'string' && value !== '') {
      manifest[key] = value
      hasField = true
    }
  }

  const modelSettings = buildModelSettings(agent.modelSettings ?? agent.model_settings)
  if (modelSettings) {
    manifest.model_settings = modelSettings
    hasField = true
  }

  const tools = buildTools(agent.tools)
  if (tools) {
    manifest.tools = tools
    hasField = true
  }

  return hasField ? manifest : undefined
}

/**
 * Folds `incoming` onto `base`, `incoming` winning per key. `model_settings` merges key by key and
 * `tools` replaces. Always returns a new object so neither argument is mutated.
 *
 * @param {AgentManifestFields | undefined} base
 * @param {AgentManifestFields} incoming
 * @returns {AgentManifestFields}
 */
function mergeAgentManifest (base, incoming) {
  const merged = { ...base, ...incoming }
  if (base?.model_settings && incoming.model_settings) {
    merged.model_settings = { ...base.model_settings, ...incoming.model_settings }
  }
  return merged
}

/**
 * @param {unknown} settings
 * @returns {Record<string, unknown> | undefined}
 */
function buildModelSettings (settings) {
  if (!isPlainObject(settings)) return

  let allowed
  for (const [key, value] of Object.entries(settings)) {
    const wireKey = toSnakeCase(key)
    if (!ALLOWED_MODEL_SETTINGS_KEYS.has(wireKey)) continue
    const wireValue = toFlatScalarValue(value)
    if (wireValue === undefined) continue
    allowed ??= {}
    allowed[wireKey] = wireValue
  }
  return allowed
}

/**
 * A JSON scalar, a flat array of scalars, or a flat object of numbers (`logit_bias`). No allowed
 * setting nests, so anything deeper is dropped rather than coerced. Returns undefined for a value
 * that cannot be reported.
 *
 * @param {unknown} value
 */
function toFlatScalarValue (value) {
  if (isScalar(value)) return value
  if (Array.isArray(value)) {
    if (value.length === 0) return
    for (const item of value) {
      if (!isScalar(item)) return
    }
    return [...value]
  }
  if (!isPlainObject(value)) return

  let numbers
  for (const [key, item] of Object.entries(value)) {
    if (!isFiniteNumber(item)) return
    numbers ??= {}
    numbers[key] = item
  }
  return numbers
}

/**
 * @param {unknown} declared
 * @returns {AgentTool[] | undefined}
 */
function buildTools (declared) {
  if (!Array.isArray(declared)) return

  const tools = []
  for (const tool of declared) {
    if (!isPlainObject(tool)) continue
    const { name, description } = tool
    // An unnamed tool is unidentifiable once it ships, so it is dropped rather than padding the count.
    if (typeof name !== 'string' || name === '') continue

    /** @type {AgentTool} */
    const built = { name }
    if (typeof description === 'string' && description !== '') built.description = description
    const parameters = buildToolParameters(tool.parameters)
    if (parameters) built.parameters = parameters
    tools.push(built)
  }
  return tools.length > 0 ? tools : undefined
}

/**
 * Flattens tool parameters to `{ param: { type?, required? } }`, the shape the framework
 * integrations emit. `required` is omitted rather than reported false.
 *
 * @param {unknown} parameters
 * @returns {Record<string, AgentToolParameter> | undefined}
 */
function buildToolParameters (parameters) {
  if (!isPlainObject(parameters)) return

  const { specs, required } = toolParameterSpecs(parameters)
  let flattened
  for (const [param, spec] of Object.entries(specs)) {
    /** @type {AgentToolParameter} */
    const entry = {}
    if (isPlainObject(spec)) {
      if (typeof spec.type === 'string' && spec.type !== '') entry.type = spec.type
      if (spec.required === true) entry.required = true
    }
    if (required?.has(param)) entry.required = true
    // A parameter with neither type nor required carries nothing to report.
    if (entry.type === undefined && entry.required === undefined) continue
    flattened ??= {}
    flattened[param] = entry
  }
  return flattened
}

/**
 * Accepts a JSON Schema object as well as the documented `{ param: { type, required } }` mapping,
 * since a JSON Schema is what OpenAI, Gemini and MCP tool definitions carry. Two markers are required
 * rather than `properties` alone, so a mapping that declares a parameter named `properties` is still
 * read as a mapping.
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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  buildAgentManifest,
  mergeAgentManifest,
}
