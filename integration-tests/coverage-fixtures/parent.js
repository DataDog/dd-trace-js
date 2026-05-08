'use strict'

const path = require('node:path')
const { fork } = require('node:child_process')

const id = require('../../packages/dd-trace/src/id')

id()

const child = fork(path.join(__dirname, 'worker.js'), { stdio: 'pipe' })

child.on('message', message => {
  if (message === 'ready') {
    process.exitCode = 0
    child.disconnect()
    child.kill()
  }
})

child.on('exit', code => {
  process.exit(code)
})
