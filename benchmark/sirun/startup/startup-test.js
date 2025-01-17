'use strict'

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()
}

if (Number(process.env.EVERYTHING)) {
  const json = require('../../../package.json')
  for (const pkg in json.dependencies) {
    try {
      require(pkg)
    } catch {}
  }
  for (const devPkg in json.devDependencies) {
    if (devPkg !== '@types/node') {
      try {
        require(devPkg)
      } catch {}
    }
  }
}
