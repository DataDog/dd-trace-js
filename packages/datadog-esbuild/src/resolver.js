'use strict'

const childProcess = require('node:child_process')
const readline = require('node:readline')

const { getEnvironmentVariables } = require('../../dd-trace/src/config/helper')

const MAX_PENDING_REQUESTS = 1024
const MAX_STDERR_LENGTH = 16 * 1024
const LOAD_OPERATION = 0
const RESOLVE_OPERATION = 1
const RESOLVER_SOURCE = `
import { createRequire, isBuiltin } from 'node:module'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

const lines = readline.createInterface({ input: process.stdin })

for await (const line of lines) {
  let request
  try {
    request = JSON.parse(line)
    let url
    if (request.kind === 'import') {
      url = await import.meta.resolve(request.specifier, request.parentURL)
    } else if (request.kind === 'require') {
      const resolved = createRequire(request.parentURL).resolve(request.specifier)
      url = isBuiltin(resolved)
        ? (resolved.startsWith('node:') ? resolved : \`node:\${resolved}\`)
        : pathToFileURL(resolved).href
    } else {
      throw new Error(\`Unsupported resolution kind: \${request.kind}\`)
    }
    process.stdout.write(JSON.stringify({ id: request.id, url }) + '\\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({
      error: {
        code: error?.code,
        message: String(error?.message ?? error),
      },
      id: request?.id,
    }) + '\\n')
  }
}
`

/** @typedef {'import'|'require'} ResolutionKind */

/** @typedef {{ specifier: string, parentURL: string }} StarReexport */

/**
 * @typedef {{ exportNames: Iterable<string>, starReexports?: StarReexport[] }} ModuleExports
 */

/**
 * @typedef {Set<string>|ModuleExports} GetExportsValue
 */

/**
 * @typedef {[typeof LOAD_OPERATION, URL, object] | [typeof RESOLVE_OPERATION, string, object]} GetExportsOperation
 */

/**
 * @typedef {{ done: false, value: GetExportsOperation } | { done: true, value: GetExportsValue }} GetExportsResult
 */

/**
 * @typedef {{
 *   next: (value?: unknown) => GetExportsResult,
 *   throw: (error?: unknown) => GetExportsResult,
 * }} GetExportsGenerator
 */

class EsmResolver {
  #child
  #closed = false
  #closedPromise
  #failure
  #nextId = 0
  #pending = new Map()
  #readline
  #rejectClosed
  #resolveClosed
  #stderr = ''

  constructor () {
    this.#closedPromise = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve
      this.#rejectClosed = reject
    })
  }

  /**
   * @param {string} specifier
   * @param {URL|string} parentURL
   * @param {ResolutionKind} [kind]
   * @returns {Promise<string>}
   */
  resolve (specifier, parentURL, kind = 'import') {
    if (this.#closed) return Promise.reject(this.#failure ?? new Error('The ESM resolver is closed'))
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error(`The ESM resolver has more than ${MAX_PENDING_REQUESTS} pending requests`))
    }

    try {
      this.#start()
    } catch (error) {
      this.#failure = error
      this.#closed = true
      this.#resolveClosed()
      return Promise.reject(error)
    }
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve })
      this.#child.stdin.write(`${JSON.stringify({ id, kind, parentURL: String(parentURL), specifier })}\n`, error => {
        if (error) this.#rejectRequest(id, error)
      })
    })
  }

  /** @returns {Promise<void>} */
  close () {
    if (!this.#closed) {
      this.#closed = true
      if (this.#child) this.#child.stdin.end()
      else this.#resolveClosed()
    }
    return this.#closedPromise
  }

  #start () {
    if (this.#child) return
    const env = getEnvironmentVariables()
    delete env.NODE_OPTIONS
    this.#child = childProcess.spawn(process.execPath, [
      '--no-warnings',
      '--experimental-import-meta-resolve',
      '--input-type=module',
      '--eval',
      RESOLVER_SOURCE,
    ], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#readline = readline.createInterface({ input: this.#child.stdout })
    this.#readline.on('line', this.#handleLine)
    this.#child.stdin.on('error', this.#handleError)
    this.#child.stderr.on('data', this.#handleStderr)
    this.#child.once('error', this.#handleError)
    this.#child.once('close', this.#handleClose)
  }

  /** @param {string} line */
  #handleLine = (line) => {
    let response
    try {
      response = JSON.parse(line)
    } catch (error) {
      this.#fail(new Error(`The ESM resolver returned malformed JSON: ${error.message}`))
      return
    }

    const id = response?.id
    if (!Number.isSafeInteger(id) || !this.#pending.has(id)) {
      this.#fail(new Error('The ESM resolver returned an unknown request identifier'))
      return
    }
    if (typeof response.url === 'string' && response.error === undefined) {
      const request = this.#pending.get(id)
      this.#pending.delete(id)
      request.resolve(response.url)
      return
    }
    if (typeof response.error?.message !== 'string' || response.url !== undefined) {
      this.#rejectRequest(id, new Error('The ESM resolver returned a malformed response'))
      return
    }

    const error = /** @type {Error & { code?: string }} */ (new Error(response.error.message))
    if (typeof response.error.code === 'string') error.code = response.error.code
    this.#rejectRequest(id, error)
  }

  /** @param {Buffer|string} chunk */
  #handleStderr = (chunk) => {
    if (this.#stderr.length >= MAX_STDERR_LENGTH) return
    this.#stderr += String(chunk).slice(0, MAX_STDERR_LENGTH - this.#stderr.length)
  }

  /** @param {Error} error */
  #handleError = (error) => {
    this.#fail(error)
  }

  /**
   * @param {number|null} code
   * @param {string|null} signal
   */
  #handleClose = (code, signal) => {
    this.#readline?.close()
    this.#closed = true
    let error = this.#failure
    if (!error && (code !== 0 || this.#pending.size > 0)) {
      const reason = signal ? `signal ${signal}` : `status ${code}`
      const stderr = this.#stderr.trim()
      error = new Error(`The ESM resolver exited with ${reason}${stderr ? `: ${stderr}` : ''}`)
      this.#failure = error
    }
    if (error) {
      this.#rejectAll(error)
      this.#rejectClosed(error)
    } else {
      this.#resolveClosed()
    }
  }

  /**
   * @param {number} id
   * @param {Error} error
   */
  #rejectRequest (id, error) {
    const request = this.#pending.get(id)
    if (!request) return
    this.#pending.delete(id)
    request.reject(error)
  }

  /** @param {Error} error */
  #fail (error) {
    if (this.#failure) return
    this.#failure = error
    this.#closed = true
    this.#rejectAll(error)
    this.#child?.stdin.destroy()
    this.#child?.kill()
  }

  /** @param {Error} error */
  #rejectAll (error) {
    for (const request of this.#pending.values()) request.reject(error)
    this.#pending.clear()
  }
}

/** @returns {EsmResolver} */
function createEsmResolver () {
  return new EsmResolver()
}

/**
 * Drives the generator returned by import-in-the-middle >=3.1.0 export discovery.
 *
 * @param {GetExportsGenerator} exportsGenerator
 * @param {(url: URL, context: object) => { source: string, format: string }} getSource
 * @param {(specifier: string, context: object) => Promise<{ format: string, url: URL }>} resolve
 * @returns {Promise<ModuleExports>}
 */
async function driveGetExportsGenerator (exportsGenerator, getSource, resolve) {
  let next = exportsGenerator.next()
  while (next.done === false) {
    let result
    let failure
    let threw = false

    try {
      const operation = next.value
      const operationType = operation[0]

      if (operationType === LOAD_OPERATION) {
        result = getSource(operation[1], operation[2])
      } else if (operationType === RESOLVE_OPERATION) {
        // eslint-disable-next-line no-await-in-loop
        result = await resolve(operation[1], operation[2])
      } else {
        throw new Error(`Unsupported import-in-the-middle getExports operation: ${operationType}`)
      }
    } catch (error) {
      threw = true
      failure = error
    }

    next = threw ? exportsGenerator.throw(failure) : exportsGenerator.next(result)
  }
  return next.value instanceof Set ? { exportNames: next.value } : next.value
}

module.exports = { createEsmResolver, driveGetExportsGenerator }
