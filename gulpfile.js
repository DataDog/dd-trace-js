'use strict'

const gulp = require('gulp')
const jsdoc = require('gulp-jsdoc3')
const jsdocConfig = require('./jsdoc.json')
const jsdocSource = ['docs/API.md', 'src/**/*.js']

gulp.task('jsdoc:watch', ['jsdoc'], () => {
  gulp.watch(jsdocSource, ['jsdoc'])
})

gulp.task('jsdoc', cb => {
  gulp.src(jsdocSource, { read: false })
    .pipe(jsdoc(jsdocConfig, cb))
})
