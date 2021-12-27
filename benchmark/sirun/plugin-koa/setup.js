'use strict'

const { spawn } = require('child_process')

const port = parseInt(process.env.PORT)
const requests = parseInt(process.env.REQUESTS)
const options = {
  detached: true,
  stdio: 'ignore',
  shell: true
}

if (process.env.WITH_NEWRELIC === 'true') {
  spawn('node endpoints/newrelic', options).unref()
}

spawn(`npx wait-on tcp:${port + 1} && npx autocannon -a ${requests} http://localhost:${port}/hello`, options).unref()
