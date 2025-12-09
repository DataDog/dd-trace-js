'use strict'

const path = require('node:path')
const pkg = require('../pkg')

const CURRENT_WORKING_DIRECTORY = process.cwd()
const ENTRYPOINT_PATH = require.main?.filename || ''

const TRACING_FIELD_NAME = '_dd.tags.process'
const DSM_FIELD_NAME = 'ProcessTags'
const PROFILING_FIELD_NAME = 'process_tags'

module.exports.TRACING_FIELD_NAME = TRACING_FIELD_NAME
module.exports.DSM_FIELD_NAME = DSM_FIELD_NAME
module.exports.PROFILING_FIELD_NAME = PROFILING_FIELD_NAME

// TODO CRASH_TRACKING_FIELD_NAME /process_tags /application/process_tags
// TODO: TELEMETRY_FIELD_NAME /application/process_tags
// TODO: DYNAMIC_INSTRUMENTATION_FIELD_NAME process_tags
// TODO: CLIENT_TRACE_STATISTICS_FIELD_NAME process_tags
// TODO: REMOTE_CONFIG_FIELD_NAME process_tags

// $ cd /foo/bar && node baz/banana.js
// entrypoint.workdir = bar
// entrypoint.name = banana
// entrypoint.type = script
// entrypoint.basedir = baz
// package.json.name = <from package.json>

module.exports = function getProcessTags () {
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
    ['package.json.name', pkg.name || undefined]
  ]

  const serialized = serialize(tags)

  return {
    tags,
    serialized
  }
}

function serialize (tags) {
  const intermediary = []
  for (const [name, value] of tags) {
    // if we don't have a value we should send nothing at all
    if (value === undefined) continue
    intermediary.push(`${name}:${sanitize(value)}`)
  }
  return intermediary.join(',')
}

module.exports.serialize = serialize

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
