'use strict'

const { run } = require('./_runner')

run('generate-content-tools').catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
