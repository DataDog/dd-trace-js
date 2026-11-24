'use strict'

require('dd-trace').init()

setTimeout(() => {
  // eslint-disable-next-line no-console
  console.log('ok')
  process.exit(0)
}, 3000)
