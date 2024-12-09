'use strict'
import fs from 'fs'
import { join } from 'path'

const ddTraceDir = join(import.meta.dirname, '..', '..', '..', '..', '..', '..')

let idCounter = 1
let initialized = false
function log (message) {
  fs.writeSync(0, message + "\n");
}

let port, entryPoint

export async function initialize (data) {
  if (initialized) {
    return Promise.reject()
  }
  initialized = true
  log(initialized)

  port = data.port2
  entryPoint = data.entryPoint

  setTimeout(() => {
    const http = import('http')
    console.log('http imported', !!http)
  }, 2000)
}

export async function resolve(specifier, context, defaultResolve) {
  const parentURL = context.parentURL ? new URL(context.parentURL).pathname : null;

  const resolved = await defaultResolve(specifier, context, defaultResolve)
  console.log('specifier, parentURL', specifier, parentURL)

  return resolved;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)

  if (!port) return result
  if (!result.source) return result
  if (url.includes(ddTraceDir) || url.includes('iitm=true')) return result

  console.log(url)

  const id = idCounter++
  return new Promise((resolve) => {
    let timeout = setTimeout(() => {
      if (timeout) {
        timeout = null
        // log('timeout - ' + url)
        resolve(result)
      }
    }, 20)

    function waitAndResolve (data) {
      if (!data || data.id !== id) return

      port.off('message', waitAndResolve)

      if (!timeout) return

      clearTimeout(timeout)
      timeout = null

      if (data.source) {
        result.source = Buffer.from(data.source)
        // console.log('url', url)
        // console.log('data.source', data.source)
      }

      resolve(result)
    }

    // log('postMessage')
    port.on('message', waitAndResolve)
    port.postMessage({ id, url, source: result.source.toString() })
  })
}
