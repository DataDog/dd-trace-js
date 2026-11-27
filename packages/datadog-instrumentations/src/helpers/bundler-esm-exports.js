'use strict'

// IITM facades for the ES modules bundler plugins intercept. import-in-the-middle analyzes the exports and generates
// the facade; this module gives it access to the module graph the way Node.js would resolve it at runtime.
const childProcess = require('node:child_process')
const fs = require('node:fs')
const { builtinModules, createRequire } = require('node:module')
const readline = require('node:readline')
const { fileURLToPath, pathToFileURL } = require('node:url')

const { getEnvironmentVariables } = require('../../../dd-trace/src/config/helper')
const { isESMFile } = require('./bundler-utils')

const MAX_PENDING_REQUESTS = 1024
const MAX_STDERR_LENGTH = 16 * 1024
const RESOLVER_SOURCE = String.raw`
import { createReadStream, createWriteStream } from 'node:fs'
import readline from 'node:readline'

const requests = createReadStream(null, { fd: 3, autoClose: false })
const responses = createWriteStream(null, { fd: 4, autoClose: false })
const lines = readline.createInterface({ input: requests })

for await (const line of lines) {
  let request
  try {
    request = JSON.parse(line)
    const url = await import.meta.resolve(request.specifier, request.parentURL)
    responses.write(JSON.stringify({ id: request.id, url }) + '\n')
  } catch (error) {
    responses.write(JSON.stringify({
      error: {
        code: error?.code,
        message: String(error?.message ?? error),
      },
      id: request?.id,
    }) + '\n')
  }
}
responses.end()
`

class EsmResolver {
  #child
  #closed = false
  #closedPromise
  #failure
  #nextId = 0
  #pending = new Map()
  #readline
  #rejectClosed
  #request
  #resolveClosed
  #stderr = ''

  constructor () {
    this.#closedPromise = new Promise((resolve, reject) => {
      this.#resolveClosed = resolve
      this.#rejectClosed = reject
    })
    // Mark lifecycle failures handled immediately. close() still returns the original promise.
    this.#closedPromise.catch(() => {})
  }

  /**
   * @param {string} specifier
   * @param {URL|string} parentURL
   * @returns {Promise<string>}
   */
  resolve (specifier, parentURL) {
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
      this.#request.write(`${JSON.stringify({ id, parentURL: String(parentURL), specifier })}\n`, error => {
        if (error) this.#rejectRequest(id, error)
      })
    })
  }

  /** @returns {Promise<void>} */
  close () {
    if (!this.#closed) {
      this.#closed = true
      if (this.#child) this.#request.end()
      else this.#resolveClosed()
    }
    return this.#closedPromise
  }

  #start () {
    if (this.#child) return
    const env = getEnvironmentVariables()
    env.DD_CIVISIBILITY_ENABLED = 'false'
    env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false'
    env.DD_TRACE_ENABLED = 'false'
    this.#child = childProcess.spawn(process.execPath, [
      '--no-warnings',
      '--experimental-import-meta-resolve',
      '--input-type=module',
      '--eval',
      RESOLVER_SOURCE,
    ], {
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    })
    this.#request = this.#child.stdio[3]
    this.#readline = readline.createInterface({ input: this.#child.stdio[4] })
    this.#readline.on('line', this.#handleLine)
    this.#request.once('error', this.#handleError)
    this.#child.stdio[4].once('error', this.#handleError)
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
    this.#request?.destroy()
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
 * @typedef {(source: string, options: { loader: 'ts' }) => { code: string }} Transform
 */

/**
 * @typedef {{ code: string, imports: Array<{ specifier: string, url: string }> }} WrapperModule
 */

/**
 * @typedef {{ createWrapperModule: (options: object) => Promise<WrapperModule> }} WrapperApi
 */

/** @type {Promise<WrapperApi> | undefined} */
let wrapperModulePromise

function loadWrapperModule () {
  wrapperModulePromise ??= import('import-in-the-middle/wrapper.mjs')
  return wrapperModulePromise
}

/**
 * @param {string} modulePath
 */
function isTypeScript (modulePath) {
  return modulePath.endsWith('.ts') || modulePath.endsWith('.mts') || modulePath.endsWith('.cts')
}

/**
 * @param {string} modulePath
 */
function getModuleFormat (modulePath) {
  const format = isESMFile(modulePath) ? 'module' : 'commonjs'
  return isTypeScript(modulePath) ? `${format}-typescript` : format
}

/**
 * Resolves a re-export the way Node.js resolves it at runtime: star exports with the import conditions, CommonJS
 * re-exports with the require conditions.
 *
 * @param {string} specifier
 * @param {{ parentURL: string, kind: 'import' | 'require' }} context
 * @param {EsmResolver} resolver
 * @returns {Promise<{ url: string, format: string }>}
 */
async function resolveModule (specifier, { parentURL, kind }, resolver) {
  const url = kind === 'require'
    ? resolveRequire(specifier, parentURL)
    : await resolver.resolve(specifier, parentURL)
  if (url.startsWith('node:')) return { url, format: 'builtin' }
  if (!url.startsWith('file:')) throw new Error(`Unsupported ESM resolution URL: ${url}`)

  const modulePath = fileURLToPath(url)
  // import-in-the-middle skips native CommonJS re-exports, but Node.js cannot import them.
  if (kind !== 'require' && modulePath.endsWith('.node')) {
    throw new Error(`Unsupported ESM analysis target: ${modulePath}`)
  }
  return { url, format: getModuleFormat(modulePath) }
}

/**
 * @param {string} specifier
 * @param {string} parentURL
 */
function resolveRequire (specifier, parentURL) {
  const resolved = createRequire(parentURL).resolve(specifier)
  if (resolved.startsWith('node:')) return resolved
  return builtinModules.includes(resolved) ? `node:${resolved}` : pathToFileURL(resolved).href
}

/**
 * @param {string} url
 * @param {string | undefined} format
 * @param {(modulePath: string) => string} readSource
 * @param {Transform} [transform]
 * @returns {{ source: string, format: string | undefined }}
 */
function loadModule (url, format, readSource, transform) {
  const modulePath = fileURLToPath(url)
  // JSON modules only export their default, which star exports do not re-export.
  if (modulePath.endsWith('.json')) return { source: '', format: 'module' }

  const source = readSource(modulePath)
  if (transform && (format === 'module-typescript' || format === 'commonjs-typescript')) {
    return {
      source: transform(source, { loader: 'ts' }).code,
      format: format === 'module-typescript' ? 'module' : 'commonjs',
    }
  }
  return { source, format }
}

/**
 * The facade imports its dependencies through placeholders. Absolute paths let bundlers resolve them like any other
 * import, while builtins keep their `node:` URLs and stay external.
 *
 * @param {WrapperModule} wrapper
 */
function mapImports ({ code, imports }) {
  for (const { specifier, url } of imports) {
    const placeholder = `from ${JSON.stringify(specifier)}`
    if (!code.includes(placeholder)) throw new Error(`The IITM facade does not import ${specifier}`)
    const target = `from ${JSON.stringify(url.startsWith('file:') ? fileURLToPath(url) : url)}`
    code = code.replaceAll(placeholder, () => target)
  }
  return code
}

/**
 * Generates the import-in-the-middle facade of an ES module or builtin for bundlers. IITM analyzes the exports and
 * owns the export bindings and hook semantics, as it does for modules wrapped by its Node.js loader. The facade
 * registers the module under the URL Node.js would load it from, and imports it, any module defining a re-exported
 * name and the IITM runtime by absolute path.
 *
 * @param {object} options
 * @param {string} options.path The file path of the module, or the name of the builtin.
 * @param {boolean} [options.internal] Whether the module is a Node.js builtin.
 * @param {string} options.specifier The specifier the module was imported by, reported to hooks.
 * @param {EsmResolver} options.resolver Resolves star exports with the import conditions.
 * @param {Map<string, string>} [options.moduleSources] Sources read so far by file path, shared across calls.
 * @param {Transform} [options.transform] Strips TypeScript before analysis.
 * @returns {Promise<string>}
 */
async function createEsmWrapper ({ path, internal, specifier, resolver, moduleSources = new Map(), transform }) {
  const { createWrapperModule } = await loadWrapperModule()
  if (internal) {
    const url = /** @type {`node:${string}`} */ (path.startsWith('node:') ? path : `node:${path}`)
    return mapImports(await createWrapperModule({ url, specifier }))
  }

  /** @param {string} modulePath */
  const readSource = (modulePath) => {
    let source = moduleSources.get(modulePath)
    if (source === undefined) {
      source = fs.readFileSync(modulePath, 'utf8')
      moduleSources.set(modulePath, source)
    }
    return source
  }
  let source = readSource(path)
  if (transform && isTypeScript(path)) source = transform(source, { loader: 'ts' }).code

  return mapImports(await createWrapperModule({
    url: pathToFileURL(path).href,
    source,
    specifier,
    resolve: (request, context) => resolveModule(request, context, resolver),
    load: (url, context) => loadModule(url, context.format, readSource, transform),
  }))
}

module.exports = { createEsmResolver, createEsmWrapper }
