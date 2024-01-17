'use strict'

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

const helpers = {
  sort,

  setup () {
    before(() => {
      process.env['AWS_SECRET_ACCESS_KEY'] = '0000000000/00000000000000000000000000000'
      process.env['AWS_ACCESS_KEY_ID'] = '00000000000000000000'
    })

    after(() => {
      delete process.env['AWS_SECRET_ACCESS_KEY']
      delete process.env['AWS_ACCESS_KEY_ID']
    })
  },

  dsmStatsExist (expectedHash) {
    const dsmStats = agent.getDsmStats()
    let hashFound = false
    if (dsmStats.length !== 0) {
      dsmStats.forEach((statsTimeBucket) => {
        statsTimeBucket.Stats.forEach((statsBucket) => {
          statsBucket.Stats.forEach((stats) => {
            if (stats.Hash.toString() === expectedHash.readBigUInt64BE(0).toString()) {
              hashFound = true
              return hashFound
            }
          })
        })
      })
    }
    return hashFound
  }
}

module.exports = helpers
