import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const [applicationPath, mode] = process.argv.slice(2)
const eventKey = Symbol.for('dd-trace:turbopack-cycle-events')

globalThis[eventKey] = []
let publications = 0

if (mode === 'disabled') {
  process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'ai'
  require('../../../datadog-instrumentations/src/helpers/bundler-register')
} else if (mode === 'named' || mode === 'default') {
  const dc = require('dc-polyfill')
  dc.channel('dd-trace:bundler:load').subscribe(payload => {
    if (payload.package !== 'ai') return
    publications++
    if (mode === 'default') {
      payload.apply(class PatchedDefault { static value = 'patched-default' }, true)
    } else {
      payload.apply({ marker: () => 'patched-marker' }, false)
    }
  })
}

const application = await import(pathToFileURL(applicationPath))
const value = await application.read()
process.stdout.write(JSON.stringify({ publications, value }))
