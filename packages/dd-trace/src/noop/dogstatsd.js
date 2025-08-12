'use strict'

/**
 * @import { DogStatsD } from "../../../../index.d.ts"
 * @implements {DogStatsD}
 */
module.exports = class NoopDogStatsDClient {
  increment () {}

  decrement () {}

  gauge () {}

  distribution () {}

  histogram () {}

  flush () {}
}
