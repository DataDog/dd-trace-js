'use strict'

const { storage } = require('../../datadog-core')
const { joinRoute } = require('../../dd-trace/src/http-resource')
const Plugin = require('../../dd-trace/src/plugins/plugin')
const web = require('../../dd-trace/src/plugins/util/web')

const legacyStorage = storage('legacy')
/** @type {import('../../dd-trace/src/http-resource').RouteReader} */
const procedureRoute = { readSamplingRoute: route => route }

/**
 * @typedef {import('node:http').IncomingMessage | import('node:http2').Http2ServerRequest} NodeRequest
 * @typedef {() => Promise<unknown>} InputReader
 * @typedef {{ req: { method?: string, query: URLSearchParams } }} LegacyRequestOptions
 * @typedef {{ path?: string, getRawInput?: InputReader }} ProcedureOptions
 * @typedef {{
 *   req?: NodeRequest,
 *   adapterInput?: Request | LegacyRequestOptions,
 *   batch?: boolean,
 *   path?: string,
 *   inputReaders?: InputReader | Set<InputReader>,
 *   named?: boolean,
 * }} RequestCarrier
 * @typedef {{ arguments: [{ req: NodeRequest }] }} RequestContext
 * @typedef {{
 *   arguments?: [{ req: Request }],
 *   request?: LegacyRequestOptions,
 *   result?: {
 *     isBatchCall: boolean,
 *     path?: string,
 *     calls?: Array<{ path: string, getRawInput: InputReader }>
 *   },
 * }} RequestInfoContext
 * @typedef {{
 *   arguments: [ProcedureOptions],
 *   currentStore?: { trpcCarrier?: RequestCarrier },
 * }} ProcedureContext
 */

class TrpcRequestPlugin extends Plugin {
  static id = 'trpc'

  /** @type {WeakSet<ProcedureOptions>} */
  #legacyProcedures = new WeakSet()

  /**
   * @param {object} tracer
   * @param {import('../../dd-trace/src/config/config-base')} tracerConfig
   */
  constructor (tracer, tracerConfig) {
    super(tracer, tracerConfig)

    this.addBind('tracing:orchestrion:@trpc/server:request:start',
      /** @param {RequestContext} ctx */ ctx => {
        const { req } = ctx.arguments[0]
        const store = legacyStorage.getStore()
        const context = web.getContext(req)
        if (!context?.span) {
          return store?.trpcCarrier ? { ...store, trpcCarrier: undefined } : store
        }

        const carrier = /** @type {RequestCarrier} */ ({ req })
        context.res.once('close', () => {
          carrier.req = undefined
          carrier.adapterInput = undefined
          carrier.inputReaders = undefined
        })
        return { ...store, trpcCarrier: carrier }
      })
    this.addSub('tracing:orchestrion:@trpc/server:nodeRequest:start', this.#setNodeRequest)
    this.addSub('tracing:orchestrion:@trpc/server:requestInfo:asyncEnd', this.#setRequestInfo)
    this.addSub('tracing:orchestrion:@trpc/server:legacyProcedure:start', this.#markLegacyProcedure)
    this.addSub('tracing:orchestrion:@trpc/server:procedure:start', this.#nameRoute)
  }

  /** @param {Request | LegacyRequestOptions} request */
  #setNodeRequest (request) {
    const carrier = /** @type {RequestCarrier | undefined} */ (legacyStorage.getStore()?.trpcCarrier)
    if (carrier?.req && web.getContext(carrier.req)?.paths.length) {
      carrier.adapterInput = request
    }
  }

  /** @param {{ request: LegacyRequestOptions, procedure: ProcedureOptions }} dispatch */
  #markLegacyProcedure ({ request, procedure }) {
    const carrier = /** @type {RequestCarrier | undefined} */ (legacyStorage.getStore()?.trpcCarrier)
    if (carrier && !carrier.named && carrier.adapterInput === request) {
      this.#legacyProcedures.add(procedure)
    }
  }

  /** @param {RequestInfoContext} ctx */
  #setRequestInfo (ctx) {
    const carrier = /** @type {RequestCarrier | undefined} */ (legacyStorage.getStore()?.trpcCarrier)
    const result = ctx.result
    if (!carrier?.adapterInput || !result || (ctx.request ?? ctx.arguments?.[0]?.req) !== carrier.adapterInput) {
      return
    }

    const { calls } = result
    carrier.batch = result.isBatchCall
    carrier.path = result.path ?? (calls?.length === 1 ? calls[0].path : undefined)

    if (!calls) {
      return
    }
    if (calls.length === 1) {
      carrier.inputReaders = calls[0].getRawInput
    } else {
      const inputReaders = new Set()
      for (const call of calls) inputReaders.add(call.getRawInput)
      carrier.inputReaders = inputReaders
    }
  }

  /** @param {ProcedureContext} ctx */
  #nameRoute (ctx) {
    const carrier = ctx.currentStore?.trpcCarrier
    const procedure = ctx.arguments[0]
    const path = procedure?.path
    if (!carrier?.req || typeof path !== 'string' || carrier.named || (!carrier.batch && carrier.path !== path)) {
      return
    }

    const { getRawInput } = procedure
    const { inputReaders, req } = carrier
    if (inputReaders) {
      if (!getRawInput || (typeof inputReaders === 'function'
        ? inputReaders !== getRawInput
        : !inputReaders.has(getRawInput))) {
        return
      }
    } else if (!this.#legacyProcedures.delete(procedure)) {
      return
    }

    const context = web.getContext(req)
    const mount = joinRoute(context.paths)
    const useMount = carrier.batch || (mount && context.config.DD_TRACE_OTEL_SEMANTICS_ENABLED)
    const route = useMount ? mount : `${mount}/${path}`
    web.setSamplingRouteReader(context, procedureRoute)
    web.setRoute(req, route)
    carrier.named = true
  }
}

module.exports = TrpcRequestPlugin
