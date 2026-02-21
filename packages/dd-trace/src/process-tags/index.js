'use strict'

const path = require('node:path')

const CURRENT_WORKING_DIRECTORY = process.cwd()
const ENTRYPOINT_PATH = require.main?.filename || ''

// $ cd /foo/bar && node baz/banana.js
// entrypoint.workdir = bar
// entrypoint.name = banana
// entrypoint.type = script
// entrypoint.basedir = baz
// package.json.name = <from package.json>

// process tags are constant throughout the lifetime of a process
function getProcessTags (config) {
  // Lazy load pkg to avoid issues with require.main during test initialization
  const pkg = require('../pkg')

  // this list is sorted alphabetically for consistent serialization
  const tags = [
    // the parent directory name of the entrypoint script, e.g. /foo/bar/baz/banana.js -> baz
    ['entrypoint.basedir', ENTRYPOINT_PATH === '' ? undefined : path.basename(path.dirname(ENTRYPOINT_PATH))],

    // the entrypoint script filename without the extension, e.g. /foo/bar/baz/banana.js -> banana
    ['entrypoint.name', path.basename(ENTRYPOINT_PATH, path.extname(ENTRYPOINT_PATH)) || undefined],

    // always script for JavaScript applications
    ['entrypoint.type', 'script'],

    // last segment of the current working directory, e.g. /foo/bar/baz/ -> baz
    ['entrypoint.workdir', path.basename(CURRENT_WORKING_DIRECTORY) || undefined],

    // the .name field from the application's package.json
    ['package.json.name', pkg.name || undefined],
  ]

  if (config && config.isServiceNameInferred) {
    tags.push(['svc.auto', config.service])
  } else if (config) {
    tags.push(['svc.user', true])
  }

  const tagsArray = []
  const tagsObject = {}

  for (const [key, value] of tags) {
    if (value !== undefined) {
      const sanitizedValue = sanitize(value)
      tagsArray.push(`${key}:${sanitizedValue}`)
      tagsObject[key] = sanitizedValue
    }
  }

  const serialized = tagsArray.join(',')

  return {
    tags,
    serialized,
    tagsObject,
    tagsArray,
  }
}

// This lets the singletong be initialiazed with config values,
// we should only allow one initialization to take place
// module.exports = processTags
const processTags = {}
module.exports = processTags
let initialized = false

module.exports.initialize = (config) => {
  // ensure initialize only happens once
  if (initialized) return
  initialized = true

  Object.assign(processTags, getProcessTags(config))
}

// Export the singleton
// module.exports = getProcessTags()

module.exports.TRACING_FIELD_NAME = '_dd.tags.process'
module.exports.DSM_FIELD_NAME = 'ProcessTags'
module.exports.PROFILING_FIELD_NAME = 'process_tags'
module.exports.DYNAMIC_INSTRUMENTATION_FIELD_NAME = 'process_tags'
module.exports.TELEMETRY_FIELD_NAME = 'process_tags'
module.exports.REMOTE_CONFIG_FIELD_NAME = 'process_tags'
module.exports.CRASH_TRACKING_FIELD_NAME = 'process_tags'
module.exports.CLIENT_TRACE_STATISTICS_FIELD_NAME = 'ProcessTags'

/**
 * Sanitize a process tag value
 *
 * @param {string} value
 * @returns {string}
 */
function sanitize (value) {
  return String(value)
    .toLowerCase()
    .replaceAll(/[^a-zA-Z0-9/_.-]+/g, '_')
}

module.exports.sanitize = sanitize
