'use strict'

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

const helpers = {
  sort,

  setup () {
    before(() => {
      process.env.AWS_SECRET_ACCESS_KEY = '0000000000/00000000000000000000000000000'
      process.env.AWS_ACCESS_KEY_ID = '00000000000000000000'
      process.env.DD_DATA_STREAMS_ENABLED = 'true'
    })

    after(() => {
      delete process.env.AWS_SECRET_ACCESS_KEY
      delete process.env.AWS_ACCESS_KEY_ID
      delete process.env.DD_DATA_STREAMS_ENABLED
    })
  }
}

module.exports = helpers
