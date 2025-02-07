'use strict'

import path from 'path'
import { URL } from 'url'
import { getName } from '../telemetry/verbosity.js'
import { isNotLibraryFile, isPrivateModule } from './filter.js'
import constants from './constants.js'

const currentUrl = new URL(import.meta.url)
const ddTraceDir = path.join(currentUrl.pathname, '..', '..', '..', '..', '..', '..')

let port, rewriter

export async function initialize (data) {
  if (rewriter) return Promise.reject(new Error('ALREADY INITIALIZED'))

  const { csiMethods, telemetryVerbosity, chainSourceMap } = data
  port = data.port

  const iastRewriter = await import('@datadog/native-iast-rewriter')

  const { NonCacheRewriter } = iastRewriter.default

  rewriter = new NonCacheRewriter({
    csiMethods,
    telemetryVerbosity: getName(telemetryVerbosity),
    chainSourceMap
  })
}

export async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)

  if (!port) return result
  if (!result.source) return result
  if (url.includes(ddTraceDir) || url.includes('iitm=true')) return result

  try {
    if (isPrivateModule(url) && isNotLibraryFile(url)) {
      const rewritten = rewriter.rewrite(result.source.toString(), url)

      if (rewritten?.content) {
        result.source = rewritten.content || result.source
        const data = { url, rewritten }
        port.postMessage({ type: constants.REWRITTEN_MESSAGE, data })
      }
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
