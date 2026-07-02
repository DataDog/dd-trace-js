'use strict'

const pick = require('../../../../datadog-core/src/utils/src/pick')
const log = require('../../log')

const { DsmPathwayCodec } = require('../../datastreams')

const base64Key = 'dd-pathway-ctx-base64'
const logKeys = [base64Key]

class DSMTextMapPropagator {
  constructor (config) {
    this.config = config
  }

  /**
   * @param {object} ctx DSM pathway context.
   * @param {Record<string, string>} carrier
   * @returns {boolean} Whether the pathway context was written into `carrier`.
   */
  inject (ctx, carrier) {
    if (!this.config.dsmEnabled) return false

    const injected = DsmPathwayCodec.encode(ctx, carrier)

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Inject into carrier (DSM): ${JSON.stringify(pick(carrier, logKeys))}.`)

    return injected
  }

  extract (carrier) {
    if (!this.config.dsmEnabled) return

    const dsmContext = DsmPathwayCodec.decode(carrier)

    if (!dsmContext) return dsmContext

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Extract from carrier (DSM): ${JSON.stringify(pick(carrier, logKeys))}.`)
    return dsmContext
  }
}

module.exports = DSMTextMapPropagator
