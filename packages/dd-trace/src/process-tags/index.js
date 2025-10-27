'use strict'

const path = require('node:path')
const pkg = require('../pkg')
const { tags } = require('../config_defaults')

const CURRENT_WORKING_DIRECTORY = process.cwd()
const ENTRYPOINT_PATH = require.main?.filename || ''
console.log('ENTRYPOINT_PATH:', ENTRYPOINT_PATH)
console.log('CURRENT_WORKING_DIRECTORY:', CURRENT_WORKING_DIRECTORY)

// if we don't have a value we should send nothing at all
// e.g. undefined which is dropped upon JSON serialization

// $ cd /foo/bar && node baz/banana.js
// entrypoint.workdir = bar
// entrypoint.name = banana
// entrypoint.type = script
// entrypoint.basedir = baz
// package.json.name = <from package.json>

module.exports = function getProcessTags () {
  // this list is sorted alphabetically for consistent serialization
  const tags = [
    // the immediate parent directory name of the entrypoint script, e.g. /foo/bar/baz/banana.js -> baz
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

function serialize(tags) {
  const intermediary = []
  for (let [name, value] of tags) {
    if (value === undefined) continue
    intermediary.push(`${name}:${sanitize(value)}`)
  }
  return intermediary.join(',')
}

/**
 * Sanitize a process tag value
 * 
 * @param {string} value 
 * @returns {string}
 */
function sanitize(value) {
  return String(value)
    .toLowerCase()
    .replaceAll(/[^a-zA-Z0-9/_.-]/g, '_')
}