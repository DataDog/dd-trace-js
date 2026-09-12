'use strict'

const { run } = require('./_runner')

run('invoke-error').catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
