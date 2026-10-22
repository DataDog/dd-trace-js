'use strict'

const log = require('../log')

// Use the shared, schemaless DEBUG product until the APM_PROFILING schema is ready.
const PRODUCT = 'DEBUG'

// Changes to these payload settings require a profiler restart.
const REMOTELY_CONFIGURABLE_SETTINGS = /** @type {const} */ ([
  'DD_PROFILING_CPU_ENABLED',
  'DD_PROFILING_WALLTIME_ENABLED',
  'DD_PROFILING_HEAP_ENABLED',
  'DD_PROFILING_UPLOAD_PERIOD',
])

// Keep every mapped profile type here; enablement is derived from this list.
const PROFILE_TYPES = /** @type {const} */ (['cpuTime', 'wallTime', 'memory'])

/**
 * @typedef {ReturnType<import('../config')>} Config
 * @typedef {{ cpuTime?: boolean, wallTime?: boolean, memory?: boolean }} RequestedProfilers
 * @typedef {{ uploadIntervalSeconds?: number }} RequestedSettings
 * @typedef {{ service?: string, env?: string, tags: string[] }} Target
 * @typedef {{
 *   id: string,
 *   profilers: RequestedProfilers,
 *   settings: RequestedSettings,
 *   targets: Target[],
 * }} ProfilingConfig
 */

/**
 * Apply matching profiling configs; omitted fields use local settings.
 *
 * @param {import('../remote_config')} rc - RemoteConfig instance
 * @param {Config} config - Tracer configuration
 */
function enable (rc, config) {
  /** @type {Map<string, ProfilingConfig>} */
  const configs = new Map()
  // Match the initially empty profiling layer.
  let lastSettings = 'null'

  rc.subscribeProducts(PRODUCT)
  rc.setBatchHandler([PRODUCT], (transaction) => {
    for (const item of transaction.toUnapply) {
      configs.delete(item.id)
      transaction.ack(item.path)
    }

    for (const item of [...transaction.toApply, ...transaction.toModify]) {
      const parsed = parse(item.id, item.file)
      if (parsed === undefined) {
        configs.delete(item.id)
      } else {
        configs.set(item.id, parsed)
      }
      transaction.ack(item.path)
    }

    // Skip unchanged settings to avoid redundant telemetry and config publishes.
    // toSettings inserts keys in a fixed order, making JSON equality stable.
    const settings = toSettings(merge(configs.values(), config))
    const serialized = JSON.stringify(settings)
    if (serialized === lastSettings) return
    lastSettings = serialized

    config.setRemoteConfig(settings, 'profiling')
  })
}

/**
 * @param {string} id - Remote config id
 * @param {unknown} file - Remote config payload
 * @returns {ProfilingConfig | undefined} undefined for unrelated payloads or invalid targets
 */
function parse (id, file) {
  if (file === null || typeof file !== 'object') return

  const { profilers, settings, targets } = /** @type {Record<string, unknown>} */ (file)
  // Payloads without either section belong to other DEBUG users.
  if (profilers === undefined && settings === undefined) return

  const parsedTargets = parseTargets(id, targets)
  if (parsedTargets === undefined) return

  return {
    id,
    profilers: parseProfilers(id, profilers),
    settings: parseSettings(id, settings),
    targets: parsedTargets,
  }
}

/**
 * @param {string} id - Remote config id
 * @param {unknown} profilers - The payload's `profilers` section
 * @returns {RequestedProfilers}
 */
function parseProfilers (id, profilers) {
  /** @type {RequestedProfilers} */
  const parsed = {}
  if (!isObject(profilers)) {
    if (profilers !== undefined) log.debug('[profiling/remote-config] Ignoring invalid profilers in %s', id)
    return parsed
  }
  for (const type of PROFILE_TYPES) {
    const value = profilers[type]
    if (typeof value === 'boolean') {
      parsed[type] = value
    } else if (value !== undefined) {
      log.debug('[profiling/remote-config] Ignoring invalid profilers.%s in %s: %o', type, id, value)
    }
  }
  return parsed
}

/**
 * @param {string} id - Remote config id
 * @param {unknown} settings - The payload's `settings` section
 * @returns {RequestedSettings}
 */
function parseSettings (id, settings) {
  /** @type {RequestedSettings} */
  const parsed = {}
  if (!isObject(settings)) {
    if (settings !== undefined) log.debug('[profiling/remote-config] Ignoring invalid settings in %s', id)
    return parsed
  }
  const { uploadIntervalSeconds } = settings
  if (Number.isInteger(uploadIntervalSeconds) && /** @type {number} */ (uploadIntervalSeconds) > 0) {
    parsed.uploadIntervalSeconds = /** @type {number} */ (uploadIntervalSeconds)
  } else if (uploadIntervalSeconds !== undefined) {
    log.debug('[profiling/remote-config] Ignoring invalid settings.uploadIntervalSeconds in %s: %o',
      id, uploadIntervalSeconds)
  }
  return parsed
}

/**
 * @param {string} id - Remote config id
 * @param {unknown} targets - The payload's `targets` section
 * @returns {Target[] | undefined} undefined if the config must be dropped
 */
function parseTargets (id, targets) {
  if (targets === undefined) return []
  if (!Array.isArray(targets)) {
    log.debug('[profiling/remote-config] Ignoring %s: targets is not an array', id)
    return
  }

  /** @type {Target[]} */
  const parsed = []
  for (const target of targets) {
    if (!isObject(target)) continue
    const { service, env, tags = [] } = target
    if ((service !== undefined && typeof service !== 'string') ||
        (env !== undefined && typeof env !== 'string') ||
        !Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) {
      continue
    }
    parsed.push({ service, env, tags })
  }

  // Reject an all-invalid target list rather than treating it as untargeted.
  if (parsed.length === 0 && targets.length !== 0) {
    log.debug('[profiling/remote-config] Ignoring %s: no valid targets', id)
    return
  }
  return parsed
}

/**
 * Merge matching configs field by field, with more specific targets winning.
 *
 * @param {Iterable<ProfilingConfig>} configs - Parsed remote configs
 * @param {Config} config - Tracer configuration
 */
function merge (configs, config) {
  /** @type {{ specificity: number, config: ProfilingConfig }[]} */
  const matching = []
  for (const profilingConfig of configs) {
    const specificity = getSpecificity(profilingConfig.targets, config)
    if (specificity !== -1) {
      matching.push({ specificity, config: profilingConfig })
    }
  }
  // Merge least specific first; break ties by ID so delivery order doesn't matter.
  matching.sort((a, b) => a.specificity - b.specificity || (a.config.id < b.config.id ? -1 : 1))

  /** @type {RequestedProfilers} */
  const profilers = {}
  /** @type {RequestedSettings} */
  const settings = {}
  for (const { config: profilingConfig } of matching) {
    Object.assign(profilers, profilingConfig.profilers)
    Object.assign(settings, profilingConfig.settings)
  }
  return { profilers, settings }
}

/**
 * Highest matching target specificity, or -1 if none matches.
 *
 * @param {Target[]} targets - Targets of one config
 * @param {Config} config - Tracer configuration
 */
function getSpecificity (targets, config) {
  if (targets.length === 0) return 0

  let specificity = -1
  for (const { service, env, tags } of targets) {
    const hasService = service !== undefined && service !== '*'
    const hasEnv = env !== undefined && env !== '*'
    if ((hasService && service !== config.service) ||
        (hasEnv && env !== config.env) ||
        !tags.every(tag => hasTag(config.tags, tag))) {
      continue
    }
    // service+env > service > env > tags only > no restriction
    let targetSpecificity = 0
    if (hasService && hasEnv) {
      targetSpecificity = 4
    } else if (hasService) {
      targetSpecificity = 3
    } else if (hasEnv) {
      targetSpecificity = 2
    } else if (tags.length !== 0) {
      targetSpecificity = 1
    }
    specificity = Math.max(specificity, targetSpecificity)
  }
  return specificity
}

/**
 * @param {Record<string, string>} tags - Tracer tags
 * @param {string} tag - A `key:value` tag
 */
function hasTag (tags, tag) {
  const separator = tag.indexOf(':')
  return separator !== -1 && tags[tag.slice(0, separator)] === tag.slice(separator + 1)
}

/**
 * Map payload fields to profiling environment variables.
 *
 * @param {{ profilers: RequestedProfilers, settings: RequestedSettings }} merged - Merged remote configs
 * @returns {Partial<Record<import('../config/helper').SupportedEnvKey, string>> | null} null if no fields are set
 */
function toSettings ({ profilers, settings }) {
  const { cpuTime, wallTime, memory } = profilers
  const { uploadIntervalSeconds } = settings
  if (cpuTime === undefined && wallTime === undefined && memory === undefined && uploadIntervalSeconds === undefined) {
    return null
  }

  /** @type {Partial<Record<import('../config/helper').SupportedEnvKey, string>>} */
  const envs = {}
  if (wallTime !== undefined) {
    envs.DD_PROFILING_WALLTIME_ENABLED = String(wallTime)
  }
  if (cpuTime !== undefined) {
    envs.DD_PROFILING_CPU_ENABLED = String(cpuTime)
    // CPU time requires the wall profiler, even when wall time is disabled.
    if (cpuTime) {
      envs.DD_PROFILING_WALLTIME_ENABLED = 'true'
    }
  }
  if (memory !== undefined) {
    envs.DD_PROFILING_HEAP_ENABLED = String(memory)
  }

  // Any true enables profiling; all false disables it; otherwise use the local setting.
  if (PROFILE_TYPES.some(type => profilers[type] === true)) {
    envs.DD_PROFILING_ENABLED = 'true'
  } else if (PROFILE_TYPES.every(type => profilers[type] === false)) {
    envs.DD_PROFILING_ENABLED = 'false'
  }

  if (uploadIntervalSeconds !== undefined) {
    envs.DD_PROFILING_UPLOAD_PERIOD = String(uploadIntervalSeconds)
  }

  return envs
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

module.exports = {
  enable,
  PRODUCT,
  REMOTELY_CONFIGURABLE_SETTINGS,
}
