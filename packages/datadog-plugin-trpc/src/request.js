'use strict'

const { storage } = require('../../datadog-core')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')
const { HTTP_ROUTE } = require('../../../ext/tags')

const legacyStorage = storage('legacy')

/**
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {{ req?: IncomingMessage, batch?: boolean, path?: string, named?: boolean }} RequestCarrier
 * @typedef {{ arguments: [{ req: IncomingMessage }] }} RequestContext
 * @typedef {{ result?: {
 *   isBatchCall: boolean,
 *   path?: string,
 *   calls?: Array<{ path: string }>
 * } }} RequestInfoContext
 * @typedef {{ arguments: [{ path?: string }], currentStore?: { trpcCarrier?: RequestCarrier } }}
 *   ProcedureContext
 */

class TrpcRequestPlugin extends Plugin {
  static id = 'trpc'

  /** @type {WeakMap<IncomingMessage, RequestCarrier>} */
  #carriers = new WeakMap()

  /**
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)

    this.addBind('tracing:orchestrion:@trpc/server:request:start',
      /** @param {RequestContext} ctx */ ctx => {
        const req = ctx.arguments[0]?.req
        if (!req) return legacyStorage.getStore()

        const carrier = { req }
        this.#carriers.set(req, carrier)
        return { ...legacyStorage.getStore(), trpcCarrier: carrier }
      })
    this.addSub('tracing:orchestrion:@trpc/server:requestInfo:asyncEnd', this.#setRequestInfo)
    this.addSub('tracing:orchestrion:@trpc/server:procedure:asyncEnd', this.#nameRoute)
    this.addSub('apm:http:server:request:finish', this.#finishRequest)
  }

  /** @param {RequestInfoContext} ctx */
  #setRequestInfo (ctx) {
    const carrier = /** @type {RequestCarrier | undefined} */ (legacyStorage.getStore()?.trpcCarrier)
    const result = ctx.result
    if (!carrier?.req || !result) return

    carrier.batch = result.isBatchCall
    carrier.path = result.path ?? (result.calls?.length === 1 ? result.calls[0].path : undefined)
  }

  /** @param {ProcedureContext} ctx */
  #nameRoute (ctx) {
    const carrier = ctx.currentStore?.trpcCarrier
    const path = ctx.arguments[0]?.path
    if (!carrier?.req || typeof path !== 'string' || carrier.batch || carrier.path !== path || carrier.named) return

    const context = web.getContext(carrier.req)
    if (!context?.paths?.length || context.span?.context().hasTag(HTTP_ROUTE)) return

    web.enterRoute(carrier.req, `/${path}`)
    carrier.named = true
  }

  /** @param {{ req: IncomingMessage }} ctx */
  #finishRequest ({ req }) {
    const carrier = this.#carriers.get(req)
    if (!carrier) return

    carrier.req = undefined
    this.#carriers.delete(req)
  }
}

module.exports = TrpcRequestPlugin
