'use strict'

require('../../packages/dd-trace').init({
  crashtracking: { enabled: true },
})

throw new TypeError('integration test uncaught exception')
