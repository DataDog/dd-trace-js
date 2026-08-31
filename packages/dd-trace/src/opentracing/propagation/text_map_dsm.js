'use strict'

const { pickDsm } = require('../../carrier')
const log = require('../../log')

const { DsmPathwayCodec } = require('../../datastreams')

class DSMTextMapPropagator {
  constructor (config) {
    this.config = config
  }

  /**
   * @param {object} ctx DSM pathway context.
   * @param {Record<string, string>} [carrier]
   * @returns {Record<string, string> | undefined}
   */
  inject (ctx, carrier) {
    if (!this.config.dsmEnabled) return

    const injectedCarrier = DsmPathwayCodec.encode(ctx, carrier)
    if (injectedCarrier === undefined) return

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Inject into carrier (DSM): ${JSON.stringify(pickDsm(injectedCarrier))}.`)

    return injectedCarrier
  }

  extract (carrier) {
    if (!this.config.dsmEnabled) return

    const dsmContext = DsmPathwayCodec.decode(carrier)

    if (!dsmContext) return dsmContext

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.debug(() => `Extract from carrier (DSM): ${JSON.stringify(pickDsm(carrier))}.`)
    return dsmContext
  }
}

module.exports = DSMTextMapPropagator
