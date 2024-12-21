'use strict'

import path from 'path'
import { URL } from 'url'

const currentUrl = new URL(import.meta.url)
const ddTraceDir = path.join(currentUrl.pathname, '..', '..', '..', '..', '..', '..')

let idCounter = 1
let initialized = false

let port

export async function initialize (data) {
  if (initialized) return Promise.reject(new Error('ALREADY INITIALIZED'))
  initialized = true

  port = data.port2
}

export async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)

  if (!port) return result
  if (!result.source) return result
  if (url.includes(ddTraceDir) || url.includes('iitm=true')) return result

  const id = idCounter++
  return new Promise((resolve) => {
    let timeout = setTimeout(() => {
      if (timeout) {
        timeout = null
        resolve(result)
      }
    }, 20)
    timeout.unref()

    function waitAndResolve (data) {
      if (!data || data.id !== id) return

      port.off('message', waitAndResolve)

      if (!timeout) return

      clearTimeout(timeout)
      timeout = null

      if (data.source) {
        result.source = Buffer.from(data.source)
      }

      resolve(result)
    }

    port.on('message', waitAndResolve)
    port.postMessage({ id, url, source: result.source.toString() })
  })
}
