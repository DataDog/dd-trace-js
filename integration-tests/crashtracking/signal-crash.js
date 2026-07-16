'use strict'

require('../../packages/dd-trace').init({
  crashtracking: { enabled: true },
})

process.kill(process.pid, 'SIGABRT')
