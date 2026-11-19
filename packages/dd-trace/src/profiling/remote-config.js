'use strict'

const { normalizeService } = require('../config/normalize-service')
const applyRemoteConfig = require('../config/remote-config-layers')
const log = require('../log')
const { allocationProfilingAvailable, cpuProfilingAvailable } = require('./runtime-capabilities')

const PRODUCT = 'APM_PROFILING'

/** @typedef {'cpuTime' | 'wallTime' | 'heapSize' | 'heapObjects' | 'allocations'} ProfileType */

// Keep every mapped profile type here; parsing is derived from this list. Profile types Node.js
// can't collect, like locks and exceptions, are ignored. So are CPU time and allocations where this
// runtime can't collect them, as the tracer configuration would turn them off again.
const PROFILE_TYPES = /** @type {ProfileType[]} */ (['wallTime', 'heapSize', 'heapObjects'])
if (cpuProfilingAvailable) PROFILE_TYPES.unshift('cpuTime')
if (allocationProfilingAvailable) PROFILE_TYPES.push('allocations')

// Profile types collected by the heap profiler.
const HEAP_PROFILE_TYPES = /** @type {ProfileType[]} */ (['heapSize', 'heapObjects', 'allocations'])

// Running profiler types (see the profiling layer's getRunningTypes()) by the profile types they serve.
const PROFILE_TYPES_BY_RUNNING_TYPE = /** @type {Record<string, ProfileType[]>} */ ({
  cpu: ['cpuTime'],
  wall: ['wallTime'],
  space: ['heapSize', 'heapObjects'],
  allocations: ['allocations'],
})

// Specificity levels of a target, from least to most specific, following the profiling Remote
// Config payload merging ADR: other tags < env < service < workload < container name < pod <
// container ID. Infrastructure levels are recognized by the tag names the Datadog agent assigns.
const LEVEL_OTHER_TAGS = 1
const LEVEL_ENV = 2
const LEVEL_SERVICE = 3
/** @type {Map<string, number>} */
const LEVEL_BY_TAG_NAME = new Map()
for (const [level, names] of /** @type {[number, string[]][]} */ ([
  [4, ['kube_deployment', 'kube_replica_set', 'kube_stateful_set', 'kube_daemon_set', 'kube_job', 'kube_cronjob',
    'kube_argo_rollout', 'oshift_deployment', 'task_family']],
  [5, ['kube_container_name', 'container_name', 'ecs_container_name']],
  [6, ['pod_name', 'task_arn']],
  [7, ['container_id']],
])) {
  for (const name of names) LEVEL_BY_TAG_NAME.set(name, level)
}
// A target's level outranks any number of conditions, which only break ties within a level.
const CONDITIONS_PER_LEVEL = 1000

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
  // The libdatadog fetcher used in agentless mode doesn't know APM_PROFILING yet, and would log an
  // error for it.
  if (config.DD_AGENTLESS_ENABLED) return

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

    applyRemoteConfig(config, PRODUCT, settings)
  })
}

/**
 * @param {string} id - Remote config id
 * @param {unknown} file - Remote config payload
 * @param {string[]} problems - Validation errors to report
 * @returns {ProfilingConfig | undefined} undefined for payloads without profiling content or with
 *   invalid targets
 */
function parse (id, file, problems) {
  if (!isObject(file)) {
    problems.push('payload is not an object')
    return
  }

  const { profilers, settings, targets } = file
  if (profilers === undefined && settings === undefined) return

  const parsedTargets = parseTargets(targets, problems)
  if (parsedTargets === undefined) return

  const parsedProfilers = parseProfilers(profilers, problems)
  if (settings !== undefined && !isObject(settings)) problems.push('settings is not an object')
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
 * A target ranks by its most specific condition, and then by its number of conditions.
 *
 * @param {Target[]} targets - Targets of one config
 * @param {Config} config - Tracer configuration
 */
function getSpecificity (targets, config) {
  let specificity = 0
  for (const { service, env, tags } of targets) {
    const hasService = service !== undefined && service !== '*'
    const hasEnv = env !== undefined && env !== '*'
    // The agent and the backend match normalized values, so compare normalized values too.
    if ((hasService && normalizeService(service) !== normalizeService(config.service)) ||
        (hasEnv && normalizeService(env) !== normalizeService(config.env))) {
      continue
    }

    let level = 0
    if (hasService) level = LEVEL_SERVICE
    else if (hasEnv) level = LEVEL_ENV
    for (const tag of tags) {
      const separator = tag.indexOf(':')
      const name = (separator === -1 ? tag : tag.slice(0, separator)).toLowerCase()
      level = Math.max(level, LEVEL_BY_TAG_NAME.get(name) ?? LEVEL_OTHER_TAGS)
    }
    const conditions = Number(hasService) + Number(hasEnv) + tags.length
    specificity = Math.max(specificity, level * CONDITIONS_PER_LEVEL + conditions)
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
    const served = PROFILE_TYPES_BY_RUNNING_TYPE[runningType]
    if (served === undefined) continue
    for (const profileType of served) {
      profileTypes.add(profileType)
    }
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
  const enablesProfiling = PROFILE_TYPES.some(type => requested[type] === true)
  if (enablesProfiling) {
    for (const type of PROFILE_TYPES) {
      if (profilers[type] === undefined && !localProfileTypes.has(type)) profilers[type] = false
    }
  }
  const { cpuTime, wallTime, heapSize, heapObjects, allocations } = profilers
  // A profile type is on when requested, or when omitted and running locally. A type that is on
  // keeps the profiler that collects it running, even if the payload turns another type of that
  // profiler off.
  /** @param {ProfileType} type */
  const isOn = type => profilers[type] ?? localProfileTypes.has(type)

  /** @type {Partial<Record<import('../config/helper').SupportedEnvKey, string>>} */
  const envs = {}
  // The wall profiler also samples CPU time.
  if (wallTime || cpuTime) {
    envs.DD_PROFILING_WALLTIME_ENABLED = 'true'
  } else if (wallTime === false && !isOn('cpuTime')) {
    envs.DD_PROFILING_WALLTIME_ENABLED = 'false'
  }
  if (cpuTime !== undefined) {
    envs.DD_PROFILING_CPU_ENABLED = String(cpuTime)
  }
  // The heap profiler collects heap sizes, live objects and, in allocation mode, allocations.
  if (heapSize || heapObjects || allocations) {
    envs.DD_PROFILING_HEAP_ENABLED = 'true'
  } else if ((heapSize === false || heapObjects === false) && !HEAP_PROFILE_TYPES.some(isOn)) {
    envs.DD_PROFILING_HEAP_ENABLED = 'false'
  }
  if (allocations !== undefined) {
    envs.DD_PROFILING_ALLOCATION_ENABLED = String(allocations)
  }

  // Any true enables profiling, and no type left on disables it; otherwise use the local setting.
  if (enablesProfiling) {
    envs.DD_PROFILING_ENABLED = 'true'
  } else if (!PROFILE_TYPES.some(isOn)) {
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
}
