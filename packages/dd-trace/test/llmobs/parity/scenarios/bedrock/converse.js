'use strict'

const { run } = require('./_runner')

run('converse').catch(error => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
