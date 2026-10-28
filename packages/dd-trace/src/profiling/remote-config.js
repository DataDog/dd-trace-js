'use strict'

const { NODE_MAJOR } = require('../../../../version')
const log = require('../log')

// Use the shared, schemaless DEBUG product until the APM_PROFILING schema is ready.
const PRODUCT = 'DEBUG'

// Changes to these payload settings require a profiler restart.
const REMOTELY_CONFIGURABLE_SETTINGS = /** @type {const} */ ([
  'DD_PROFILING_CPU_ENABLED',
  'DD_PROFILING_WALLTIME_ENABLED',
  'DD_PROFILING_HEAP_ENABLED',
  'DD_PROFILING_ALLOCATION_ENABLED',
])

/** @typedef {'cpuTime' | 'wallTime' | 'heapSize' | 'allocations'} ProfileType */

// Keep every mapped profile type here; parsing and enablement are derived from this list. Profile
// types this runtime can't collect, like lock and exception, are ignored. So are allocations before
// Node.js 26, where the tracer configuration turns allocation profiling off.
const PROFILE_TYPES = /** @type {ProfileType[]} */ (
  NODE_MAJOR >= 26 ? ['cpuTime', 'wallTime', 'heapSize', 'allocations'] : ['cpuTime', 'wallTime', 'heapSize']
)

// Running profiler types (see the profiling layer's getRunningTypes()) by the profile type they serve.
const PROFILE_TYPE_BY_RUNNING_TYPE = /** @type {Record<string, ProfileType>} */ ({
  cpu: 'cpuTime',
  wall: 'wallTime',
  space: 'heapSize',
  allocations: 'allocations',
})

/**
 * @typedef {ReturnType<import('../config')>} Config
 * @typedef {Partial<Record<ProfileType, boolean>>} RequestedProfilers
 * @typedef {{ service?: string, env?: string, tags: string[] }} Target
 * @typedef {{
 *   id: string,
 *   profilers: RequestedProfilers,
 *   targets: Target[],
 * }} ProfilingConfig
 */

/**
 * Apply matching profiling configs; omitted fields use local settings.
 *
 * @param {import('../remote_config')} rc - RemoteConfig instance
 * @param {Config} config - Tracer configuration
 * @param {() => string[]} getRunningProfileTypes - Types of the running profilers
 */
function enable (rc, config, getRunningProfileTypes) {
  /** @type {Map<string, ProfilingConfig>} */
  const configs = new Map()
  // Match the initially empty profiling layer.
  let lastSettings = 'null'
  /**
   * Profile types running under local configuration, captured before the first profiling content
   * is applied. Known limitations: a profiler that SSI heuristics start later, or that APM_TRACING
   * enabled earlier, is not told apart from local configuration.
   *
   * @type {Set<string> | undefined}
   */
  let localProfileTypes

  rc.subscribeProducts(PRODUCT)
  rc.setBatchHandler([PRODUCT], (transaction) => {
    for (const item of transaction.toUnapply) {
      configs.delete(item.id)
      transaction.ack(item.path)
    }

    for (const item of [...transaction.toApply, ...transaction.toModify]) {
      /** @type {string[]} */
      const problems = []
      const parsed = parse(item.id, item.file, problems)
      if (parsed === undefined) {
        configs.delete(item.id)
      } else {
        configs.set(item.id, parsed)
      }

      if (problems.length === 0) {
        transaction.ack(item.path)
      } else {
        // Report partial failures while still applying valid fields.
        const reason = problems.join('; ')
        log.debug('[profiling/remote-config] Invalid profiling configuration %s: %s', item.id, reason)
        transaction.error(item.path, reason)
      }
    }

    // Skip unchanged settings to avoid redundant telemetry and config publishes.
    // toSettings inserts keys in a fixed order, making JSON equality stable.
    const merged = merge(configs.values(), config)
    if (configs.size > 0) {
      localProfileTypes ??= toProfileTypes(getRunningProfileTypes())
    }
    const settings = toSettings(merged, localProfileTypes ?? new Set())
    const serialized = JSON.stringify(settings)
    if (serialized === lastSettings) return
    lastSettings = serialized

    config.setRemoteConfig(settings, 'profiling')
  })
}

/**
 * @param {string} id - Remote config id
 * @param {unknown} file - Remote config payload
 * @param {string[]} problems - Validation errors to report
 * @returns {ProfilingConfig | undefined} undefined for unrelated payloads or invalid targets
 */
function parse (id, file, problems) {
  if (file === null || typeof file !== 'object') return

  const { profilers, settings, targets } = /** @type {Record<string, unknown>} */ (file)
  // Payloads without either section belong to other DEBUG users.
  if (profilers === undefined && settings === undefined) return

  const parsedTargets = parseTargets(targets, problems)
  if (parsedTargets === undefined) return

  const parsedProfilers = parseProfilers(profilers, problems)
  validateSettings(settings, problems)
  return { id, profilers: parsedProfilers, targets: parsedTargets }
}

/**
 * @param {unknown} profilers - The payload's `profilers` section
 * @param {string[]} problems - Validation errors to report
 * @returns {RequestedProfilers}
 */
function parseProfilers (profilers, problems) {
  /** @type {RequestedProfilers} */
  const parsed = {}
  if (!isObject(profilers)) {
    if (profilers !== undefined) problems.push('profilers is not an object')
    return parsed
  }
  for (const type of PROFILE_TYPES) {
    const value = profilers[type]
    if (typeof value === 'boolean') {
      parsed[type] = value
    } else if (value !== undefined) {
      problems.push(`profilers.${type} is not a boolean`)
    }
  }
  return parsed
}

/**
 * The schema defines no settings this runtime maps yet, so only the section's shape is checked.
 *
 * @param {unknown} settings - The payload's `settings` section
 * @param {string[]} problems - Validation errors to report
 */
function validateSettings (settings, problems) {
  if (settings !== undefined && !isObject(settings)) problems.push('settings is not an object')
}

/**
 * @param {unknown} targets - The payload's `targets` section
 * @param {string[]} problems - Validation errors to report
 * @returns {Target[] | undefined} undefined if the config must be dropped
 */
function parseTargets (targets, problems) {
  if (targets === undefined) return []
  if (!Array.isArray(targets)) {
    problems.push('targets is not an array')
    return
  }

  /** @type {Target[]} */
  const parsed = []
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]
    const { service, env, tags = [] } = isObject(target) ? target : {}
    if (!isObject(target) ||
        (service !== undefined && typeof service !== 'string') ||
        (env !== undefined && typeof env !== 'string') ||
        !Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) {
      problems.push(`targets[${index}] is invalid`)
      continue
    }
    parsed.push({ service, env, tags })
  }

  // Reject an all-invalid target list rather than treating it as untargeted.
  if (parsed.length === 0 && targets.length !== 0) {
    problems.push('no valid targets')
    return
  }
  return parsed
}

/**
 * Merge the received configs field by field, with more specific targets winning. Remote Config only
 * delivers configs that apply to this tracer, so every config is merged; targets only rank them.
 *
 * @param {Iterable<ProfilingConfig>} configs - Parsed remote configs
 * @param {Config} config - Tracer configuration
 */
function merge (configs, config) {
  /** @type {{ specificity: number, config: ProfilingConfig }[]} */
  const ranked = []
  for (const profilingConfig of configs) {
    ranked.push({ specificity: getSpecificity(profilingConfig.targets, config), config: profilingConfig })
  }
  // Merge least specific first; break ties by ID so delivery order doesn't matter.
  ranked.sort((a, b) => a.specificity - b.specificity || (a.config.id < b.config.id ? -1 : 1))

  /** @type {RequestedProfilers} */
  const profilers = {}
  for (const { config: profilingConfig } of ranked) {
    Object.assign(profilers, profilingConfig.profilers)
  }
  return profilers
}

/**
 * Specificity of the most specific target that is consistent with this tracer's service and env,
 * or 0 if there is none. A config's targets can name several scopes, and the one it was delivered
 * for has to be consistent with them. Tag conditions are assumed to hold: the agent has matched
 * them, and the tracer doesn't know every tag it's matched by (e.g. Kubernetes tags).
 *
 * @param {Target[]} targets - Targets of one config
 * @param {Config} config - Tracer configuration
 */
function getSpecificity (targets, config) {
  let specificity = 0
  for (const { service, env, tags } of targets) {
    const hasService = service !== undefined && service !== '*'
    const hasEnv = env !== undefined && env !== '*'
    if ((hasService && service !== config.service) || (hasEnv && env !== config.env)) continue

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
 * @param {string[]} runningTypes - Types of the running profilers
 * @returns {Set<string>} The profile types they serve
 */
function toProfileTypes (runningTypes) {
  const profileTypes = new Set()
  for (const runningType of runningTypes) {
    const profileType = PROFILE_TYPE_BY_RUNNING_TYPE[runningType]
    if (profileType !== undefined) profileTypes.add(profileType)
  }
  return profileTypes
}

/**
 * Map payload fields to profiling environment variables.
 *
 * @param {RequestedProfilers} requested - Profile types requested by the merged remote configs
 * @param {Set<string>} localProfileTypes - Profile types running under local configuration
 * @returns {Partial<Record<import('../config/helper').SupportedEnvKey, string>> | null} null if no fields are set
 */
function toSettings (requested, localProfileTypes) {
  if (PROFILE_TYPES.every(type => requested[type] === undefined)) return null

  // Turning profiling on also starts every profile type that is on by default, so omitted types
  // that weren't running locally are turned off; omitted types that were keep their local value.
  /** @type {RequestedProfilers} */
  const profilers = { ...requested }
  if (PROFILE_TYPES.some(type => requested[type] === true)) {
    for (const type of PROFILE_TYPES) {
      if (profilers[type] === undefined && !localProfileTypes.has(type)) profilers[type] = false
    }
  }
  const { cpuTime, wallTime, heapSize, allocations } = profilers

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
  if (heapSize !== undefined) {
    envs.DD_PROFILING_HEAP_ENABLED = String(heapSize)
  }
  if (allocations !== undefined) {
    envs.DD_PROFILING_ALLOCATION_ENABLED = String(allocations)
    // Allocations are collected by the heap profiler, even when heap size is disabled.
    if (allocations) {
      envs.DD_PROFILING_HEAP_ENABLED = 'true'
    }
  }

  // Any true enables profiling; all false disables it; otherwise use the local setting.
  if (PROFILE_TYPES.some(type => profilers[type] === true)) {
    envs.DD_PROFILING_ENABLED = 'true'
  } else if (PROFILE_TYPES.every(type => profilers[type] === false)) {
    envs.DD_PROFILING_ENABLED = 'false'
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
