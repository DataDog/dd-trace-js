'use strict'

const os = require('os')

const log = require('../../log')
const { getValueFromEnvSources } = require('../../config/helper')

const OS_PLATFORM = 'os.platform'
const OS_VERSION = 'os.version'
const OS_ARCHITECTURE = 'os.architecture'
const RUNTIME_NAME = 'runtime.name'
const RUNTIME_VERSION = 'runtime.version'
const DD_HOST_CPU_COUNT = '_dd.host.vcpu_count'

const RUNTIME_TAGS_OVERRIDE_KEYS = new Set([OS_PLATFORM, OS_VERSION, OS_ARCHITECTURE, RUNTIME_NAME, RUNTIME_VERSION])

function getRuntimeAndOSMetadata () {
  return {
    [RUNTIME_VERSION]: process.version,
    [OS_ARCHITECTURE]: process.arch,
    [OS_PLATFORM]: process.platform,
    [RUNTIME_NAME]: 'node',
    [OS_VERSION]: os.release(),
    [DD_HOST_CPU_COUNT]: os.cpus().length,
    ...getRuntimeTagsOverrides(),
  }
}

/**
 * Reads the OS and runtime tag values set in DD_TEST_OPTIMIZATION_RUNTIME_TAGS.
 *
 * @returns {Record<string, string>}
 */
function getRuntimeTagsOverrides () {
  const value = getValueFromEnvSources('DD_TEST_OPTIMIZATION_RUNTIME_TAGS')
  if (typeof value !== 'string' || !value.trim()) return {}

  let overrides
  try {
    overrides = JSON.parse(value)
  } catch {}
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    log.warn('Ignoring DD_TEST_OPTIMIZATION_RUNTIME_TAGS: expected a JSON object, got %s', value)
    return {}
  }

  const tags = {}
  for (const [tag, tagValue] of Object.entries(overrides)) {
    if (!RUNTIME_TAGS_OVERRIDE_KEYS.has(tag) || typeof tagValue !== 'string') continue
    const trimmedValue = tagValue.trim()
    if (trimmedValue) tags[tag] = trimmedValue
  }
  return tags
}

module.exports = {
  getRuntimeAndOSMetadata,
  OS_PLATFORM,
  OS_VERSION,
  OS_ARCHITECTURE,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  DD_HOST_CPU_COUNT,
}
