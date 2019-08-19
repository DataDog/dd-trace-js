'use strict'

module.exports = bundle

const browserify = require('browserify')

const sourcemaps = require('gulp-sourcemaps')
const gutil = require('gulp-util')

const buffer = require('vinyl-buffer')
const vinylfs = require('vinyl-fs')
const source = require('vinyl-source-stream')

/**
 * Bundles the library.
 * @param {Object} options Bundler options
 * @param {string} options.entry Entry file
 * @param {string} options.target Target directory
 * @param {boolean} [options.compress=false] Whether to minify or not
 * @returns {undefined}
 */
function bundle (options) {
  if (!options || !options.entry || !options.target) { throw TypeError('missing options') }

  const bundler = browserify({
    entries: options.entry,
    debug: true,
    standalone: 'DatadogTracer'
  })
    .transform('browserify-shim')
    .transform('babelify')

  return bundler
    .plugin(require('bundle-collapser/plugin'))
    .bundle()
    .pipe(source('datadog-tracer.js'))
    .pipe(buffer())
    .pipe(sourcemaps.init({ loadMaps: true }))
    .pipe(sourcemaps.write('.', { sourceRoot: '' }))
    .pipe(vinylfs.dest(options.target))
    .on('log', gutil.log)
    .on('error', gutil.log)
}
