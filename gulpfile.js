const gulp = require('gulp')
const bundle = require('./scripts/bundle')

const defaultTask = []

function defineTask (entry, target) {
  gulp.task('bundle', bundle.bind(this, {
    entry: entry,
    target: target
  }))

  defaultTask.push('bundle')
}

defineTask('./browser', './dist')

gulp.task('default', defaultTask)
