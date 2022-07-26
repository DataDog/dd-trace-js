if (Number(process.env.USE_TRACER)) {
  require('../../../ci/jest/env')
}

const env = require('../../../versions/jest-environment-node').get()

module.exports = env.default ? env.default : env
