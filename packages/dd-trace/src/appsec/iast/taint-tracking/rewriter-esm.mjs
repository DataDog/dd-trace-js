import path from 'path'
import { URL } from 'url'
import { getName } from '../telemetry/verbosity.js'
import { isDdTrace, isPrivateModule } from './filter.js'
import constants from './constants.js'

const currentUrl = new URL(import.meta.url)
const ddTraceDir = path.join(currentUrl.pathname, '..', '..', '..', '..', '..', '..')

let port, rewriter, iastEnabled

export async function initialize (data) {
  if (rewriter) throw new Error('ALREADY INITIALIZED')

  const { csiMethods, telemetryVerbosity, chainSourceMap, orchestrionConfig } = data
  port = data.port
  iastEnabled = data.iastEnabled

  const iastRewriter = await import('@datadog/wasm-js-rewriter')

  const { NonCacheRewriter } = iastRewriter.default

  rewriter = new NonCacheRewriter({
    csiMethods,
    telemetryVerbosity: getName(telemetryVerbosity),
    chainSourceMap,
    orchestrion: orchestrionConfig
  })
}

export async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)

  if (!port) return result
  if (!result.source) return result
  if (url.includes(ddTraceDir) || url.includes('iitm=true')) return result

  let passes
  try {
    if (isDdTrace(url)) {
      return result
    }
    if (isPrivateModule(url)) {
      // TODO error tracking needs to be added based on config
      passes = ['error_tracking']
      if (iastEnabled) {
        passes.push('iast')
      }
    } else {
      passes = ['orchestrion']
    }
    const rewritten = rewriter.rewrite(result.source.toString(), url, passes)

    if (rewritten?.content) {
      result.source = rewritten.content || result.source
      const data = { url, rewritten }
      port.postMessage({ type: constants.REWRITTEN_MESSAGE, data })
    }
  } catch (e) {
    const newErrObject = {
      message: e.message,
      stack: e.stack
    }

    const data = {
      level: 'error',
      messages: ['[ASM] Error rewriting file %s', url, newErrObject]
    }
    port.postMessage({
      type: constants.LOG_MESSAGE,
      data
    })
  }

  return result
}
