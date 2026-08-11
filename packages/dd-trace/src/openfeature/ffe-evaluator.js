'use strict'

const SEMVER_OPERATORS = new Set([
  'SEMVER_EQ', 'SEMVER_NEQ', 'SEMVER_LT', 'SEMVER_LTE', 'SEMVER_GT', 'SEMVER_GTE',
])
const OPERATORS = new Set([
  'LT', 'LTE', 'GT', 'GTE', 'MATCHES', 'NOT_MATCHES', 'ONE_OF', 'NOT_ONE_OF', 'IS_NULL',
  ...SEMVER_OPERATORS,
])
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const UINT64_MAX = '18446744073709551615'

/**
 * Validates flags independently and converts SemVer conditions into rules the
 * upstream evaluator can execute with per-request synthetic attributes.
 *
 * @param {import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined} [configuration]
 * @returns {{
 *   configuration: import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined,
 *   rejected: Set<string>,
 *   sourceConfiguration: import('@datadog/openfeature-node-server').UniversalFlagConfigurationV1 | undefined,
 *   semverConditions: Map<string, Array<{
 *     attribute: string,
 *     comparand: string,
 *     operator: string,
 *     syntheticAttribute: string
 *   }>>
 * }}
 */
function sanitizeConfiguration (configuration) {
  const rejected = new Set()
  const semverConditions = new Map()
  if (!configuration?.flags || typeof configuration.flags !== 'object' || Array.isArray(configuration.flags)) {
    return { configuration, rejected, semverConditions, sourceConfiguration: configuration }
  }

  const flags = { ...configuration.flags }
  for (const [key, flag] of Object.entries(configuration.flags)) {
    try {
      const conditions = []
      flags[key] = prepareFlag(key, flag, conditions)
      if (conditions.length) semverConditions.set(key, conditions)
    } catch {
      rejected.add(key)
    }
  }

  return {
    configuration: rejected.size || semverConditions.size ? { ...configuration, flags } : configuration,
    rejected,
    semverConditions,
    sourceConfiguration: configuration,
  }
}

/**
 * Adds the precomputed attributes used by transformed SemVer rules.
 *
 * @param {Array<{
 *   attribute: string,
 *   comparand: string,
 *   operator: string,
 *   syntheticAttribute: string
 * }> | undefined} conditions
 * @param {import('@openfeature/server-sdk').EvaluationContext} context
 * @returns {import('@openfeature/server-sdk').EvaluationContext}
 */
function addSemverContext (conditions, context) {
  if (!conditions) return context

  const semverContext = { ...context }
  for (const condition of conditions) {
    const matches = compareSemverOperator(
      condition.operator,
      context?.[condition.attribute],
      condition.comparand
    )
    semverContext[condition.syntheticAttribute] = matches ? 'true' : 'false'
  }
  return semverContext
}

function prepareFlag (key, flag, semverConditions) {
  if (!flag || flag.key !== key || typeof flag.enabled !== 'boolean' ||
      !['BOOLEAN', 'INTEGER', 'NUMERIC', 'STRING', 'JSON'].includes(flag.variationType)) {
    throw new Error('invalid flag')
  }
  if (!flag.variations || typeof flag.variations !== 'object' || Array.isArray(flag.variations)) {
    throw new Error('missing variations')
  }
  for (const [variationKey, variation] of Object.entries(flag.variations)) {
    if (!variation || variation.key !== variationKey || !matchesType(variation.value, flag.variationType)) {
      throw new Error('invalid variation')
    }
  }
  if (!Array.isArray(flag.allocations)) throw new Error('invalid allocations')

  let transformed = false
  const allocations = []
  for (const allocation of flag.allocations) {
    if (!allocation || !Array.isArray(allocation.splits)) throw new Error('invalid allocation')
    for (const split of allocation.splits) validateSplit(split, flag.variations)

    if (allocation.rules === undefined) {
      allocations.push(allocation)
      continue
    }
    if (!Array.isArray(allocation.rules)) throw new Error('invalid rules')

    let allocationTransformed = false
    const rules = []
    for (const rule of allocation.rules) {
      if (!rule || !Array.isArray(rule.conditions)) throw new Error('invalid rule')

      let ruleTransformed = false
      const conditions = []
      for (const condition of rule.conditions) {
        validateCondition(condition)
        if (!SEMVER_OPERATORS.has(condition.operator)) {
          conditions.push(condition)
          continue
        }

        const syntheticAttribute = `__datadog_semver_condition_${semverConditions.length}`
        semverConditions.push({
          attribute: condition.attribute,
          comparand: condition.value,
          operator: condition.operator,
          syntheticAttribute,
        })
        conditions.push({
          ...condition,
          attribute: syntheticAttribute,
          operator: 'ONE_OF',
          value: ['true'],
        })
        ruleTransformed = true
      }
      rules.push(ruleTransformed ? { ...rule, conditions } : rule)
      allocationTransformed ||= ruleTransformed
    }
    allocations.push(allocationTransformed ? { ...allocation, rules } : allocation)
    transformed ||= allocationTransformed
  }

  return transformed ? { ...flag, allocations } : flag
}

function validateSplit (split, variations) {
  if (!split || !Array.isArray(split.shards) || !Object.hasOwn(variations, split.variationKey)) {
    throw new Error('invalid split')
  }
  for (const shard of split.shards) {
    if (!shard || !Number.isSafeInteger(shard.totalShards) || shard.totalShards <= 0 ||
        shard.totalShards > 0xFF_FF_FF_FF || !Array.isArray(shard.ranges)) {
      throw new Error('invalid shard')
    }
    for (const range of shard.ranges) {
      if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
          range.start < 0 || range.start >= range.end || range.end > shard.totalShards) {
        throw new Error('invalid shard range')
      }
    }
  }
}

function validateCondition (condition) {
  if (!condition || typeof condition.attribute !== 'string' || !OPERATORS.has(condition.operator)) {
    throw new Error('invalid condition')
  }
  switch (condition.operator) {
    case 'MATCHES':
    case 'NOT_MATCHES':
      if (typeof condition.value !== 'string') throw new Error('invalid regex')
      compileRegex(condition.value)
      break
    case 'LT':
    case 'LTE':
    case 'GT':
    case 'GTE':
      if (typeof condition.value !== 'number' || !Number.isFinite(condition.value)) throw new Error('invalid number')
      break
    case 'ONE_OF':
    case 'NOT_ONE_OF':
      if (!Array.isArray(condition.value) || condition.value.some(value => typeof value !== 'string')) {
        throw new Error('invalid membership')
      }
      break
    case 'IS_NULL':
      if (typeof condition.value !== 'boolean') throw new Error('invalid null check')
      break
    default:
      parseSemver(condition.value)
  }
}

function matchesType (value, type) {
  if (type === 'BOOLEAN') return typeof value === 'boolean'
  if (type === 'STRING') return typeof value === 'string'
  if (type === 'INTEGER') return Number.isSafeInteger(value)
  if (type === 'NUMERIC') return typeof value === 'number' && Number.isFinite(value)
  return value !== undefined
}

function compileRegex (pattern) {
  const inlineFlags = pattern.match(/^\(\?([imsu]+)\)/)
  const flags = inlineFlags ? [...new Set(inlineFlags[1])].join('') : ''
  const source = (inlineFlags ? pattern.slice(inlineFlags[0].length) : pattern)
    .replaceAll('[:alnum:]', 'A-Za-z0-9')
  return new RegExp(source, flags)
}

function parseSemver (value) {
  if (typeof value !== 'string') throw new Error('invalid semantic version')
  const match = SEMVER.exec(value)
  if (!match) throw new Error('invalid semantic version')

  const core = match.slice(1, 4)
  if (core.some(part => compareNumeric(part, UINT64_MAX) > 0)) throw new Error('invalid semantic version')
  const prerelease = match[4]?.split('.')
  if (prerelease?.some(part => /^\d+$/.test(part) && compareNumeric(part, UINT64_MAX) > 0)) {
    throw new Error('invalid semantic version')
  }
  return { core, prerelease }
}

function compareSemverOperator (operator, left, right) {
  let comparison
  try {
    comparison = compareSemver(parseSemver(left), parseSemver(right))
  } catch {
    return false
  }
  if (operator === 'SEMVER_EQ') return comparison === 0
  if (operator === 'SEMVER_NEQ') return comparison !== 0
  if (operator === 'SEMVER_LT') return comparison < 0
  if (operator === 'SEMVER_LTE') return comparison <= 0
  if (operator === 'SEMVER_GT') return comparison > 0
  return comparison >= 0
}

function compareSemver (left, right) {
  for (let index = 0; index < 3; index++) {
    const result = compareNumeric(left.core[index], right.core[index])
    if (result) return result
  }
  if (!left.prerelease && !right.prerelease) return 0
  if (!left.prerelease) return 1
  if (!right.prerelease) return -1
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index++) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    let result
    if (leftNumeric && rightNumeric) {
      result = compareNumeric(leftPart, rightPart)
    } else if (leftNumeric) {
      result = -1
    } else if (rightNumeric) {
      result = 1
    } else {
      result = compareLexical(leftPart, rightPart)
    }
    if (result) return result
  }
  return Math.sign(left.prerelease.length - right.prerelease.length)
}

function compareNumeric (left, right) {
  return Math.sign(left.length - right.length) || compareLexical(left, right)
}

function compareLexical (left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

module.exports = { addSemverContext, sanitizeConfiguration }
