'use strict'

// Export analysis of ES modules for bundler plugins. processModule is copied from the `import-in-the-middle` package
// with minor modifications (https://www.npmjs.com/package/import-in-the-middle).
const childProcess = require('node:child_process')
const fs = require('node:fs')
const readline = require('node:readline')
const { fileURLToPath, pathToFileURL } = require('node:url')

const { getEnvironmentVariables } = require('../../../dd-trace/src/config/helper')
const { isESMFile } = require('./bundler-utils')

const MAX_PENDING_REQUESTS = 1024
const MAX_STDERR_LENGTH = 16 * 1024
const LOAD_OPERATION = 0
const RESOLVE_OPERATION = 1
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

const getExportsImporting = (url) => import(url).then(Object.keys)
let getExportsModulePromise

const loadGetExportsModule = () => {
  if (!getExportsModulePromise) {
    getExportsModulePromise = import('import-in-the-middle/lib/get-exports.mjs')
  }
  return getExportsModulePromise
}

/**
 * @param {URL} srcUrl
 * @param {object} context
 * @param {(url: URL, context: object) => { source: string, format: string }} getSource
 * @param {EsmResolver} resolver
 * @returns {Promise<{
 *   exportNames: Iterable<string>,
 *   hasModuleExportsCJSDefault: boolean,
 *   starReexports?: Array<{ specifier: string, parentURL: string }>
 * }>}
 */
const getExports = async (srcUrl, context, getSource, resolver) => {
  const mod = await loadGetExportsModule()
  const exportsGenerator = mod.getExports(srcUrl, context, getSource)
  /**
   * @param {string} specifier
   * @param {{ parentURL: URL }} operationContext
   * @returns {Promise<{ format: string, url: URL }>}
   */
  const resolve = (specifier, operationContext) => resolveModule(specifier, operationContext, resolver)
  const result = await driveGetExportsGenerator(exportsGenerator, getSource, resolve)
  return {
    exportNames: result.exportNames,
    hasModuleExportsCJSDefault: mod.hasModuleExportsCJSDefault,
    starReexports: result.starReexports,
  }
}

function isStarExportLine (line) {
  return /^\* from /.test(line)
}

function isBareSpecifier (specifier) {
  // Relative and absolute paths are not bare specifiers.
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/')) {
    return false
  }

  // Valid URLs are not bare specifiers. (file:, http:, node:, etc.)

  if (URL.hasOwnProperty('canParse')) {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    return !URL.canParse(specifier)
  }

  try {
    // eslint-disable-next-line no-new
    new URL(specifier)
    return false
  } catch {
    return true
  }
}

/**
 * @param {string} modulePath
 * @param {string} format
 */
function getModuleFormat (modulePath, format) {
  if (modulePath.endsWith('.mts')) return 'module-typescript'
  if (modulePath.endsWith('.cts')) return 'commonjs-typescript'
  if (modulePath.endsWith('.ts')) return `${format}-typescript`
  return format
}

/**
 * Resolves a module with the import conditions used by ESM instrumentation.
 *
 * @param {string} specifier
 * @param {{ parentURL: URL }} context
 * @param {EsmResolver} resolver
 * @returns {Promise<{ format: string, url: URL }>}
 */
async function resolveModule (specifier, context, resolver) {
  const url = new URL(await resolver.resolve(specifier, context.parentURL))
  if (url.protocol === 'node:') return { format: 'builtin', url }
  if (url.protocol !== 'file:') throw new Error(`Unsupported ESM resolution URL: ${url.href}`)

  const resolved = fileURLToPath(url)
  if (resolved.endsWith('.node')) {
    throw new Error(`Unsupported ESM analysis target: ${resolved}`)
  }
  const format = isESMFile(resolved) ? 'module' : 'commonjs'
  return { format, url }
}

/**
 * Generates the pieces of code for the proxy module before the path
 *
 * @param {object} moduleData
 * @param {string} moduleData.path
 * @param {boolean} [moduleData.internal]
 * @param {object} moduleData.context
 * @param {boolean} [moduleData.excludeDefault]
 * @param {Map<string, string>} [moduleData.moduleSources]
 * @param {EsmResolver} [moduleData.resolver]
 * @param {(source: string, options: { loader: 'ts' }) => { code: string }} [moduleData.transform]
 * @param {Set<string>} [activeModules]
 * @returns {Promise<Map>}
 */
async function processModule (
  { path, internal = false, context, excludeDefault = false, moduleSources = new Map(), resolver, transform },
  activeModules
) {
  const ownsResolver = resolver === undefined
  resolver ??= createEsmResolver()
  try {
    return await processModuleWithResolver(
      { path, internal, context, excludeDefault, moduleSources, transform },
      activeModules,
      resolver
    )
  } finally {
    if (ownsResolver) await resolver.close()
  }
}

/**
 * @param {object} moduleData
 * @param {string} moduleData.path
 * @param {boolean} moduleData.internal
 * @param {object} moduleData.context
 * @param {boolean} moduleData.excludeDefault
 * @param {Map<string, string>} moduleData.moduleSources
 * @param {(source: string, options: { loader: 'ts' }) => { code: string }} [moduleData.transform]
 * @param {Set<string>} [activeModules]
 * @param {EsmResolver} resolver
 * @returns {Promise<Map>}
 */
async function processModuleWithResolver (
  { path, internal, context, excludeDefault, moduleSources, transform },
  activeModules,
  resolver
) {
  let moduleExports, srcUrl
  if (internal) {
    // we can not read and parse of internal modules
    moduleExports = { exportNames: await getExportsImporting(path) }
  } else {
    context = { ...context, format: getModuleFormat(path, context.format) }
    srcUrl = pathToFileURL(path)
    const readSource = (url) => {
      const modulePath = fileURLToPath(url)
      let source = moduleSources.get(modulePath)
      if (source === undefined) {
        source = fs.readFileSync(modulePath, 'utf8')
        moduleSources.set(modulePath, source)
      }
      return source
    }
    const loadSource = (url, { format }) => {
      let source = readSource(url)
      if (transform && (format === 'module-typescript' || format === 'commonjs-typescript')) {
        source = transform(source, { loader: 'ts' }).code
        format = format === 'module-typescript' ? 'module' : 'commonjs'
      }
      return { format, source }
    }
    readSource(srcUrl)
    moduleExports = await getExports(srcUrl, context, loadSource, resolver)
  }

  const starExports = new Set()
  const setters = new Map()

  const addSetter = (name, setter, isStarExport = false) => {
    if (setters.has(name)) {
      if (isStarExport) {
        // If there's already a matching star export, delete it
        if (starExports.has(name)) {
          setters.delete(name)
        }
        // and return so this is excluded
        return
      }

      // if we already have this export but it is from a * export, overwrite it
      if (starExports.has(name)) {
        starExports.delete(name)
        setters.set(name, setter)
      }
    } else {
      // Store export * exports so we know they can be overridden by explicit
      // named exports
      if (isStarExport) {
        starExports.add(name)
      }

      setters.set(name, setter)
    }
  }

  let starReexports = moduleExports.starReexports
  for (const n of moduleExports.exportNames) {
    const isDefault = n === 'default' || (
      n === 'module.exports' &&
      moduleExports.hasModuleExportsCJSDefault &&
      (context.format === 'commonjs' || context.format === 'commonjs-typescript')
    )
    if (isDefault && excludeDefault) continue

    if (isStarExportLine(n)) {
      starReexports ??= []
      starReexports.push({ parentURL: srcUrl.href, specifier: n.slice('* from '.length) })
      continue
    }

    const variableName = `$dd${Buffer.from(n).toString('hex')}`
    const objectKey = JSON.stringify(n)
    const reExportedName = n === 'default' ? n : objectKey

    addSetter(n, `
      let ${variableName}
      try {
        ${variableName} = _[${objectKey}] = namespace[${objectKey}]
      } catch (error) {
        if (!(error instanceof ReferenceError)) throw error
      }
      export { ${variableName} as ${reExportedName} }
      set[${objectKey}] = (v) => {
        ${variableName} = v
        return true
      }
      get[${objectKey}] = () => ${variableName}
      `)
  }

  if (starReexports) {
    for (const { parentURL, specifier } of starReexports) {
      const baseUrl = new URL(parentURL)
      const resolvedSpecifier = isBareSpecifier(specifier) ? specifier : new URL(specifier, baseUrl).href
      // The runtime's import conditions and the declaring module's URL own star-export resolution.
      // eslint-disable-next-line no-await-in-loop
      const result = await resolveModule(resolvedSpecifier, { parentURL: baseUrl }, resolver)

      activeModules ??= new Set([srcUrl.href])
      if (activeModules.has(result.url.href)) continue
      activeModules.add(result.url.href)

      // eslint-disable-next-line no-await-in-loop
      const subSetters = await processModuleWithResolver({
        path: result.format === 'builtin' ? result.url.href : fileURLToPath(result.url),
        internal: result.format === 'builtin',
        context: { ...context, format: result.format },
        excludeDefault: true,
        moduleSources,
        transform,
      }, activeModules, resolver)
      activeModules.delete(result.url.href)

      for (const [name, setter] of subSetters.entries()) {
        addSetter(name, setter, true)
      }
    }
  }

  return setters
}

module.exports = { createEsmResolver, driveGetExportsGenerator, processModule }
