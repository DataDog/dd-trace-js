'use strict'

const { readFileSync } = require('node:fs')

const request = require('../exporters/common/request')
const log = require('../log')
const { ERROR } = require('./apply_states')

const ABI_VERSION = 4
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const RECEIPT_DIAGNOSTIC_OVERFLOW = 'Remote Config diagnostic exceeds the receipt plan limit'
const watchExports = Object.entries({ rc_watch_open: 2, rc_watch_next: 2, rc_watch_finish: 4 })

/**
 * @typedef {object} Identity
 * @property {string} clientId
 * @property {string} runtimeId
 * @property {string[]} tags
 * @property {string[]} extraServices
 *
 * @typedef {{ products: string[], capabilities: string[] }} Interest
 * @typedef {{ service: string, env: string, appVersion: string, processTags: string[] }} Target
 * @typedef {object} Options
 * @property {Target} target
 * @property {Identity} identity
 * @property {Interest} interest
 * @property {string} language
 * @property {string} tracerVersion
 * @property {string} url
 * @property {number} timeoutMs
 * @property {string} [apiKey]
 * @property {string} [hostname]
 *
 * @typedef {{ path: string, product: string, configId: string, version: string }} FileMetadata
 * @typedef {FileMetadata & { hashes: [string, string][] }} DescriptorFile
 * @typedef {{ kind: 'snapshot' | 'remove' | 'upsert', file: DescriptorFile, previous?: DescriptorFile }} ViewRecord
 * @typedef {{ records: ViewRecord[], generation: string, receiptOwner?: number }} ViewDescription
 * @typedef {{ generation: string }} RawReceipt
 * @typedef {{ path: string, configId: string }} WatchFile
 * @typedef {WatchFile & { contents: string }} WatchUpsert
 * @typedef {{ upserts: WatchUpsert[], removals: WatchFile[] }} WatchChanges
 * @typedef {'ignored' | Error} WatchDecision
 * @typedef {{ decisions: Map<string, WatchDecision>, install?: () => void }} WatchPlan
 * @typedef {(changes: WatchChanges) => WatchPlan} WatchProjector
 * @typedef {{ product: string, capabilities: bigint, project: WatchProjector }} ValueWatch
 * @typedef {FileMetadata & {
 *   kind: 'add' | 'update' | 'remove',
 *   hashes?: Record<string, string>,
 *   contents?: string,
 *   receipt?: RawReceipt,
 * }} WasmChange
 * @typedef {{ changes: WasmChange[], nextPollAfterMs: number, error?: string }} PollResult
 * @typedef {object} GuestResult
 * @property {number} batch
 * @property {boolean} [batchFullyWatched]
 * @property {number} nextPollAfterMs
 * @property {boolean} ready
 * @property {string} [error]
 * @typedef {object} HttpEvent
 * @property {'http'} kind
 * @property {number} id
 * @property {string} url
 * @property {string} method
 * @property {[string, string][]} headers
 * @property {number} body
 * @typedef {HttpEvent | { kind: 'sleep', id: number, delayMs: number } | { kind: 'cancel', id: number }} Event
 * @typedef {{ path: string, receipt: RawReceipt, state: number, message: string }} Outcome
 * @typedef {(error: Error | undefined, result?: PollResult) => void} PollCallback
 * @typedef {WebAssembly.Exports & {
 *   memory: WebAssembly.Memory,
 *   [name: `rc_${string}`]: (...args: number[]) => number
 * }} ReactorExports
 */

class WasmClient {
  /** @type {ReactorExports | undefined} */
  #exports
  #client
  #agentUrl
  #timeoutMs
  #watch
  #watchId = 0
  /** @type {Map<number, () => void>} */
  #operations = new Map()
  /** @type {Map<string, Outcome>} */
  #outcomes = new Map()
  /** @type {PollCallback | undefined} */
  #done
  #draining = false

  /**
   * @param {string} artifactPath
   * @param {Options} options
   * @param {URL | undefined} agentUrl
   * @param {ValueWatch} [watch]
   */
  constructor (artifactPath, options, agentUrl, watch) {
    const { WASI } = require('node:wasi')
    const module = new WebAssembly.Module(readFileSync(artifactPath))
    const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {}, returnOnExit: true })
    const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport })
    const { rc_version: version, rc_apply: apply, memory } = instance.exports
    if (typeof version !== 'function' || version() !== ABI_VERSION ||
        typeof apply !== 'function' || apply.length !== 4 || !(memory instanceof WebAssembly.Memory)) {
      throw new Error('Incompatible Remote Config WASM ABI')
    }
    if (watch !== undefined) {
      for (const [name, arity] of watchExports) {
        const exported = instance.exports[name]
        if (typeof exported !== 'function' || exported.length !== arity) {
          throw new Error(`Incompatible Remote Config WASM watch export: ${name}`)
        }
      }
    }
    wasi.initialize(instance)
    this.#exports = /** @type {ReactorExports} */ (instance.exports)
    this.#agentUrl = agentUrl
    this.#watch = watch
    this.#timeoutMs = options.timeoutMs
    this.#client = this.#withJson(options, input => this.#call('rc_open', input))
    const applyReceipts = instance.exports.rc_apply_receipts
    if (typeof applyReceipts !== 'function' || applyReceipts.length !== 2) {
      throw new Error('Incompatible Remote Config WASM receipt export')
    }
    if (watch !== undefined) {
      this.#watchId = this.#withJson({ delivery: 'latestState', products: [watch.product] },
        input => this.#call('rc_watch_open', this.#client, input))
    }
  }

  /**
   * @param {Identity} identity
   * @param {Interest | undefined} interest
   * @param {PollCallback} done
   */
  poll (identity, interest, done) {
    if (this.#client === 0 || this.#done !== undefined) {
      done(new Error('Remote Config WASM client is unavailable or already polling'))
      return
    }
    this.#done = done
    this.#resume(() => {
      this.#applyOutcomes()
      if (interest !== undefined) {
        this.#withJson(interest, input => this.#call('rc_set_interest', this.#client, input))
      }
      this.#withJson(identity, input => this.#call('rc_set_identity', this.#client, input))
      this.#call('rc_poll', this.#client)
    })
  }

  /** @param {Outcome} outcome */
  complete (outcome) {
    const { path, receipt } = outcome
    const pending = this.#outcomes.get(path)
    if (pending !== undefined && BigInt(pending.receipt.generation) > BigInt(receipt.generation)) return
    this.#outcomes.set(path, outcome)
  }

  #applyOutcomes () {
    if (this.#outcomes.size === 0) return

    const prefix = `{"receiptOwner":${this.#client},"outcomes":[`
    const framingBytes = prefix.length + 2
    const entries = []
    let bytes = framingBytes
    const flush = () => {
      const plan = Buffer.from(`${prefix}${entries.join(',')}]}`)
      this.#withInput(plan, input => this.#call('rc_apply_receipts', this.#client, input))
      entries.length = 0
      bytes = framingBytes
    }

    for (const { path, receipt: { generation }, state, message } of this.#outcomes.values()) {
      const entry = { path, generation, state, message: state === ERROR ? message : undefined }
      if (entry.message !== undefined && entry.message.length > MAX_RESPONSE_BYTES) {
        entry.message = RECEIPT_DIAGNOSTIC_OVERFLOW
      }
      let encoded = JSON.stringify(entry)
      let entryBytes = Buffer.byteLength(encoded)
      if (entryBytes + framingBytes > MAX_RESPONSE_BYTES && state === ERROR) {
        entry.message = RECEIPT_DIAGNOSTIC_OVERFLOW
        encoded = JSON.stringify(entry)
        entryBytes = Buffer.byteLength(encoded)
      }
      if (entries.length !== 0 && bytes + 1 + entryBytes > MAX_RESPONSE_BYTES) flush()
      bytes += entryBytes + (entries.length === 0 ? 0 : 1)
      entries.push(encoded)
    }
    flush()
    this.#outcomes.clear()
  }

  /**
   * @param {ValueWatch} watch
   */
  #deliverWatch (watch) {
    const view = this.#call('rc_watch_next', this.#client, this.#watchId)
    if (view === 0) {
      return
    }

    const update = this.#describe(view)
    const upserts = /** @type {WatchUpsert[]} */ ([])
    const removals = /** @type {WatchFile[]} */ ([])
    for (let index = 0; index < update.records.length; index++) {
      const { kind, file: { path, configId } } = update.records[index]
      if (kind === 'upsert') {
        const handle = this.#call('rc_view_file', view, index, 0)
        const contents = this.#take(handle, bytes => bytes.toString())
        upserts.push({ path, configId, contents })
      } else {
        removals.push({ path, configId })
      }
    }

    let decisions
    let outcome = 1
    let failure
    try {
      const plan = watch.project({ upserts, removals })
      decisions = plan.decisions
      if (plan.install !== undefined) {
        plan.install()
        outcome = 0
      }
    } catch (error) {
      failure = error instanceof Error
        ? error
        : new Error('Remote Config value processing threw a non-Error value', { cause: error })
      outcome = 2
      log.error('[RC] Failed to apply Remote Config values for %s', watch.product, failure)
    }

    const plan = encodeWatchPlan(update.records, outcome, decisions, failure)
    this.#withInput(plan, input => this.#call('rc_watch_finish', this.#client, this.#watchId, view, input))
  }

  /** @param {number} view */
  #describe (view) {
    return /** @type {ViewDescription} */ (this.#takeJson(this.#call('rc_view_describe', view)))
  }

  /** @param {() => void} operation */
  #resume (operation) {
    if (this.#draining) {
      operation()
      return
    }

    let result
    try {
      this.#draining = true
      try {
        operation()
        result = this.#drain()
      } finally {
        this.#draining = false
      }
    } catch (error) {
      const done = this.#done
      this.close()
      done?.(error)
      return
    }

    if (result !== undefined) {
      const done = this.#done
      this.#done = undefined
      done?.(undefined, result)
    }
  }

  close () {
    this.#done = undefined
    this.#client = 0
    for (const cancel of this.#operations.values()) cancel()
    this.#operations.clear()
    this.#outcomes.clear()
    this.#exports = undefined
  }

  #drain () {
    while (true) {
      const handle = this.#call('rc_event', this.#client)
      if (handle === 0) break
      const event = /** @type {Event} */ (this.#takeJson(handle))
      if (event.kind === 'http') {
        this.#startHttp(event)
      } else if (event.kind === 'sleep') {
        this.#startTimer(event.id, event.delayMs)
      } else {
        const cancel = this.#operations.get(event.id)
        this.#operations.delete(event.id)
        cancel?.()
      }
    }

    const handle = this.#call('rc_result', this.#client)
    if (handle === 0) return

    const { batch, batchFullyWatched, ready, ...result } = /** @type {GuestResult} */ (this.#takeJson(handle))
    if (ready && result.error === undefined && this.#watch !== undefined) {
      this.#deliverWatch(this.#watch)
    }

    let changes = []
    if (batch !== 0) {
      if (batchFullyWatched === true) {
        this.#call('rc_view_release', batch)
      } else {
        changes = this.#readBatch(batch)
      }
    }
    return { ...result, changes }
  }

  /** @param {number} batch */
  #readBatch (batch) {
    try {
      const { records, generation, receiptOwner } = this.#describe(batch)
      if (typeof receiptOwner !== 'number' || receiptOwner !== this.#client) {
        throw new Error('Invalid Remote Config WASM receipt owner')
      }
      const receipt = { generation }
      const changes = /** @type {WasmChange[]} */ ([])
      for (const [index, { kind, file, previous }] of records.entries()) {
        if (file.product === this.#watch?.product) continue

        this.#outcomes.delete(file.path)
        if (kind === 'remove') {
          const { path, product, configId, version } = file
          changes.push({ path, product, configId, version, kind })
        } else {
          const handle = this.#call('rc_view_file', batch, index, 0)
          changes.push({
            ...file,
            hashes: Object.fromEntries(file.hashes),
            kind: previous === undefined ? 'add' : 'update',
            receipt,
            contents: this.#take(handle, bytes => bytes.toString()),
          })
        }
      }
      return changes
    } finally {
      this.#call('rc_view_release', batch)
    }
  }

  /** @param {HttpEvent} event */
  #startHttp (event) {
    const { id } = event
    const controller = new AbortController()
    const url = new URL(event.url)
    const body = event.body === 0 ? Buffer.alloc(0) : this.#take(event.body, bytes => Buffer.from(bytes))
    this.#operations.set(id, () => controller.abort())
    request(body, {
      url: this.#agentUrl ?? url,
      path: `${url.pathname}${url.search}`,
      method: event.method,
      headers: Object.fromEntries(event.headers),
      responseType: 'buffer',
      maxResponseBytes: MAX_RESPONSE_BYTES,
      timeout: this.#timeoutMs,
      signal: controller.signal,
      retry: false,
    }, (error, bytes, status, headers) => {
      if (this.#client === 0 || !this.#operations.delete(id)) return
      this.#resume(() => {
        if (error) {
          this.#withInput(Buffer.from(error.message),
            message => this.#call('rc_http_fail', this.#client, id, message))
          return
        }

        const payload = bytes?.length ? this.#write(bytes) : 0
        const pairs = headerPairs(/** @type {import('node:http').IncomingHttpHeaders} */ (headers))
        this.#withJson({ status, headers: pairs }, response => {
          this.#call('rc_http_succeed', this.#client, id, response, payload)
        })
      })
    })
  }

  /**
   * @param {number} id
   * @param {number} delayMs
   */
  #startTimer (id, delayMs) {
    const timer = setTimeout(() => {
      this.#operations.delete(id)
      this.#resume(() => this.#call('rc_timer_elapsed', this.#client, id))
    }, delayMs)
    timer.unref?.()
    this.#operations.set(id, () => clearTimeout(timer))
  }

  /**
   * @param {`rc_${string}`} name
   * @param {...number} args
   */
  #call (name, ...args) {
    const exports = /** @type {ReactorExports} */ (this.#exports)
    const value = exports[name](...args)
    if (value !== -1) return value
    const error = exports.rc_error()
    throw new Error(error > 0 ? this.#take(error, bytes => bytes.toString()) : 'Remote Config WASM ABI error')
  }

  /** @param {number} handle */
  #bytes (handle) {
    const offset = this.#call('rc_buffer_ptr', handle) >>> 0
    const length = this.#call('rc_buffer_len', handle)
    const memory = /** @type {ReactorExports} */ (this.#exports).memory.buffer
    if (offset > memory.byteLength || length < 0 || length > memory.byteLength - offset) {
      throw new RangeError('Remote Config WASM buffer is outside guest memory')
    }
    return Buffer.from(memory, offset, length)
  }

  /** @param {Buffer} bytes */
  #write (bytes) {
    const handle = this.#call('rc_alloc', bytes.length)
    this.#bytes(handle).set(bytes)
    return handle
  }

  /**
   * @template Result
   * @param {Buffer} bytes
   * @param {(handle: number) => Result} use
   */
  #withInput (bytes, use) {
    const handle = this.#write(bytes)
    try {
      return use(handle)
    } finally {
      this.#call('rc_free', handle)
    }
  }

  /**
   * @template Result
   * @param {object} value
   * @param {(handle: number) => Result} use
   */
  #withJson (value, use) {
    return this.#withInput(Buffer.from(JSON.stringify(value)), use)
  }

  /**
   * @template Result
   * @param {number} handle
   * @param {(bytes: Buffer) => Result} read
   */
  #take (handle, read) {
    try {
      return read(this.#bytes(handle))
    } finally {
      this.#call('rc_free', handle)
    }
  }

  /**
   * @param {number} handle
   * @returns {unknown}
   */
  #takeJson (handle) {
    return this.#take(handle, bytes => JSON.parse(bytes.toString()))
  }
}

/**
 * @param {ViewRecord[]} records
 * @param {number} outcome
 * @param {Map<string, WatchDecision> | undefined} decisions
 * @param {Error | undefined} failure
 */
function encodeWatchPlan (records, outcome, decisions, failure) {
  const limit = Math.max(0, Math.floor((MAX_RESPONSE_BYTES - 5 - 9 * records.length) / (records.length + 1)))
  const installError = failure === undefined ? undefined : watchDiagnostic(failure.message, limit)
  let length = installError === undefined ? 1 : 5 + installError.length
  /** @type {Map<number, Buffer> | undefined} */
  let rejections

  for (const [index, { kind, file }] of records.entries()) {
    if (kind !== 'upsert') continue
    length += 5
    const decision = decisions?.get(file.path)
    if (decision instanceof Error) {
      const diagnostic = watchDiagnostic(decision.message, limit)
      length += 4 + diagnostic.length
      rejections ??= new Map()
      rejections.set(index, diagnostic)
    }
  }

  const plan = Buffer.allocUnsafe(length)
  plan[0] = outcome
  let offset = installError === undefined ? 1 : writeWatchDiagnostic(plan, 1, installError)
  for (const [index, { kind, file }] of records.entries()) {
    if (kind !== 'upsert') continue
    offset = plan.writeUInt32LE(index, offset)
    const rejection = rejections?.get(index)
    if (rejection === undefined) {
      plan[offset++] = decisions?.get(file.path) === 'ignored' ? 1 : 0
    } else {
      plan[offset++] = 2
      offset = writeWatchDiagnostic(plan, offset, rejection)
    }
  }
  return plan
}

/**
 * @param {string} message
 * @param {number} limit
 */
function watchDiagnostic (message, limit) {
  if (Buffer.byteLength(message) <= limit) return Buffer.from(message)
  const fallback = 'Remote Config watch diagnostic exceeds the plan limit'
  return Buffer.from(fallback.slice(0, limit))
}

/**
 * @param {Buffer} plan
 * @param {number} offset
 * @param {Buffer} diagnostic
 */
function writeWatchDiagnostic (plan, offset, diagnostic) {
  const start = plan.writeUInt32LE(diagnostic.length, offset)
  return start + diagnostic.copy(plan, start)
}

/** @param {import('node:http').IncomingHttpHeaders} headers */
function headerPairs (headers) {
  const pairs = []
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      pairs.push([name, value])
    } else if (Array.isArray(value)) {
      for (const member of value) pairs.push([name, member])
    }
  }
  return pairs
}

module.exports = WasmClient
