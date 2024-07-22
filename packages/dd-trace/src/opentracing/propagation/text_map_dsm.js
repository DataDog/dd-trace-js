const pick = require('../../../../datadog-core/src/utils/src/pick')
const log = require('../../log')

const { DsmPathwayCodec } = require('../../datastreams/pathway')

const base64Key = 'dd-pathway-ctx-base64'
const logKeys = [base64Key]

class DSMTextMapPropagator {
  constructor (config) {
    this.config = config
  }

  inject (ctx, carrier) {
    if (!this.config.dsmEnabled) return

    this._injectDatadogDSMContext(ctx, carrier)

    log.debug(() => `Inject into carrier (DSM): ${JSON.stringify(pick(carrier, logKeys))}.`)
  }

  extract (carrier) {
    if (!this.config.dsmEnabled) return

    const dsmContext = this._extractDatadogDSMContext(carrier)

    if (!dsmContext) return dsmContext

    log.debug(() => `Extract from carrier (DSM): ${JSON.stringify(pick(carrier, logKeys))}.`)
    return dsmContext
  }

  _injectDatadogDSMContext (ctx, carrier) {
    DsmPathwayCodec.encode(ctx, carrier)
  }

  _extractDatadogDSMContext (carrier) {
    const ctx = DsmPathwayCodec.decode(carrier)
    return ctx
  }
}

module.exports = DSMTextMapPropagator
