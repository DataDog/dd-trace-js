'use strict'

const { storage } = require('../../datadog-core')
const { joinRoute } = require('../../dd-trace/src/http-resource')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')
const { HTTP_ROUTE } = require('../../../ext/tags')

const legacyStorage = storage('legacy')

/**
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {() => Promise<unknown>} InputReader
 * @typedef {{
 *   req?: IncomingMessage,
 *   batch?: boolean,
 *   path?: string,
 *   inputReaders?: InputReader | Set<InputReader>,
 *   named?: boolean,
 * }} RequestCarrier
 * @typedef {{ arguments: [{ req: IncomingMessage }] }} RequestContext
 * @typedef {{ result?: {
 *   isBatchCall: boolean,
 *   path?: string,
 *   calls?: Array<{ path: string, getRawInput: InputReader }>
 * } }} RequestInfoContext
 * @typedef {{
 *   arguments: [{ path?: string, getRawInput?: InputReader }],
 *   currentStore?: { trpcCarrier?: RequestCarrier },
 * }} ProcedureContext
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
        const { req } = ctx.arguments[0]
        const carrier = { req }
        this.#carriers.set(req, carrier)
        return { ...legacyStorage.getStore(), trpcCarrier: carrier }
      })
    this.addSub('tracing:orchestrion:@trpc/server:requestInfo:asyncEnd', this.#setRequestInfo)
    this.addSub('tracing:orchestrion:@trpc/server:procedure:start', ctx => this.#resolveRoute(ctx, false))
    this.addSub('tracing:orchestrion:@trpc/server:procedure:asyncEnd', ctx => this.#resolveRoute(ctx, true))
    this.addSub('apm:http:server:request:finish', this.#finishRequest)
  }

  /** @param {RequestInfoContext} ctx */
  #setRequestInfo (ctx) {
    const carrier = /** @type {RequestCarrier | undefined} */ (legacyStorage.getStore()?.trpcCarrier)
    const result = ctx.result
    if (!carrier?.req || !result) return

    const { calls } = result
    carrier.batch = result.isBatchCall
    carrier.path = result.path ?? (calls?.length === 1 ? calls[0].path : undefined)

    if (!calls) return
    if (calls.length === 1) {
      carrier.inputReaders = calls[0].getRawInput
    } else {
      const inputReaders = new Set()
      for (const call of calls) inputReaders.add(call.getRawInput)
      carrier.inputReaders = inputReaders
    }
  }

  /**
   * @param {ProcedureContext} ctx
   * @param {boolean} finished
   */
  #resolveRoute (ctx, finished) {
    const carrier = ctx.currentStore?.trpcCarrier
    const procedure = ctx.arguments[0]
    const path = procedure?.path
    if (!carrier?.req || typeof path !== 'string' || carrier.named) return
    if (carrier.batch ? finished : carrier.path !== path) return

    const { getRawInput } = procedure
    const { inputReaders, req } = carrier
    if (inputReaders && (!getRawInput || (typeof inputReaders === 'function'
      ? inputReaders !== getRawInput
      : !inputReaders.has(getRawInput)))) return

    const context = web.getContext(req)
    if (!context?.paths?.length || !context.span) return

    const spanContext = context.span.context()
    if (spanContext.hasTag(HTTP_ROUTE)) {
      const route = spanContext.getTag(HTTP_ROUTE)
      if (!finished && typeof route === 'string') web.setSamplingRoute(req, route)
    } else if (carrier.batch) {
      web.setSamplingRoute(req, joinRoute(context.paths))
    } else if (finished) {
      web.enterRoute(req, `/${path}`)
      web.setSamplingRoute(req, joinRoute(context.paths))
      carrier.named = true
    } else {
      web.setSamplingRoute(req, `${joinRoute(context.paths)}/${path}`)
    }
  }

  /** @param {{ req: IncomingMessage }} ctx */
  #finishRequest ({ req }) {
    const carrier = this.#carriers.get(req)
    if (!carrier) return

    carrier.req = undefined
    carrier.inputReaders = undefined
    this.#carriers.delete(req)
  }
}

module.exports = TrpcRequestPlugin
