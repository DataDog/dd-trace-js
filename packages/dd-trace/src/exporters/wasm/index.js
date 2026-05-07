'use strict'

const path = require('path')
const { URL } = require('url')
const log = require('../../log')
const { getAgentUrl } = require('../../agent/url')
const Writer = require('./writer')

// Path to libdatadog-nodejs prebuilds (sibling of dd-trace-js in workspace)
// From packages/dd-trace/src/exporters/wasm: 6 levels up = dd-trace-js root;
// libdatadog-nodejs is sibling of dd-trace-js in workspace
const TRACE_EXPORTER_PATH = path.join(
  __dirname,
  '..', '..', '..', '..', '..', '..', 'libdatadog-nodejs',
  'prebuilds', 'trace_exporter', 'trace_exporter.js'
)

let traceExporterModule = null

function loadWasmModule () {
  if (traceExporterModule) return traceExporterModule

  try {
    traceExporterModule = require(TRACE_EXPORTER_PATH)
    if (traceExporterModule.init) {
      traceExporterModule.init()
    }
    return traceExporterModule
  } catch (e) {
    throw new Error(
      `Failed to load wasm trace exporter from ${TRACE_EXPORTER_PATH}. ` +
      `Ensure libdatadog-nodejs is built (yarn build-wasm) and available as a sibling of dd-trace-js. ${e.message}`
    )
  }
}

class WasmExporter {
  #timer

  constructor (config, prioritySampler) {
    this._config = config
    this._url = getAgentUrl(config)
    const urlString = this._url instanceof URL ? this._url.href : String(this._url)
    const service = config.service || 'node'

    const mod = loadWasmModule()
    this._jsTraceExporter = new mod.JsTraceExporter(urlString, service)

    this._writer = new Writer({ url: this._url, prioritySampler, config })
    this._writer.setJsExporter(this._jsTraceExporter)

    const beforeExitHandlers = globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers
    if (beforeExitHandlers) {
      beforeExitHandlers.add(this.flush.bind(this))
    }
  }

  setUrl (url) {
    try {
      this._url = url instanceof URL ? url : new URL(url)
      // JsTraceExporter does not support URL changes; would need to recreate for full support
      log.debug('WasmExporter: setUrl called (not implemented for wasm, URL unchanged)')
    } catch (e) {
      log.warn(e.stack)
    }
  }

  export (spans) {
    this._writer.append(spans)

    const { flushInterval } = this._config

    if (flushInterval === 0) {
      this._writer.flush()
    } else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this._writer.flush()
        this.#timer = undefined
      }, flushInterval).unref()
    }
  }

  flush (done = () => {}) {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this._writer.flush(done)
  }
}

module.exports = WasmExporter
