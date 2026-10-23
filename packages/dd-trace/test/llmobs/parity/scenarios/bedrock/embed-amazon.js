'use strict'

const { run } = require('./_runner')

run('embed-amazon').catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
