'use strict'

const path = require('node:path')
const pkg = require('../pkg')

const CURRENT_WORKING_DIRECTORY = process.cwd()
const ENTRYPOINT_PATH = require.main?.filename || ''

module.exports = function processTags () {
  return {
    // last segment of the current working directory, e.g. /foo/bar/baz/ -> baz
    'entrypoint.workdir': path.basename(CURRENT_WORKING_DIRECTORY),

    // the entrypoint script filename without the extension, e.g. /foo/bar/baz/banana.js -> banana
    'entrypoint.name': path.basename(ENTRYPOINT_PATH, path.extname(ENTRYPOINT_PATH)),

    // always script for JavaScript applications
    'entrypoint.type': 'script',

    // the immediate parent directory name of the entrypoint script, e.g. /foo/bar/baz/banana.js -> baz
    'entrypoint.basedir': path.basename(path.dirname(ENTRYPOINT_PATH)),

    // the .name field from the application's package.json
    'package.json.name': pkg.name
  }
}
