'use strict'

const { join, dirname } = require('path')
const { normalize } = require('source-map/lib/util')
const { loadSourceMapSync } = require('./source-maps')
const session = require('./session')
const log = require('./log')

const WINDOWS_DRIVE_LETTER_REGEX = /[a-zA-Z]/

const loadedScripts = []
const scriptUrls = new Map()
let reEvaluateProbesTimer = null

module.exports = {
  locationToBreakpoint: new Map(),
  breakpointToProbes: new Map(),
  probeToLocation: new Map(),

  _loadedScripts: loadedScripts, // Only exposed for testing
  _scriptUrls: scriptUrls, // Only exposed for testing

  /**
   * Find the script to inspect based on a partial or absolute path. Handles both Windows and POSIX paths.
   *
   * @param {string} path - Partial or absolute path to match against loaded scripts
   * @returns {Object | null} - Object containing `url`, `scriptId`, `sourceMapURL`, and `source` - or null if no match
   */
  findScriptFromPartialPath (path) {
    if (!path) return null // This shouldn't happen, but better safe than sorry

    path = path.toLowerCase()

    const bestMatch = { url: null, scriptId: null, sourceMapURL: null, source: null }
    let maxMatchLength = -1

    for (const { url, sourceUrl, scriptId, sourceMapURL, source } of loadedScripts) {
      let i = url.length - 1
      let j = path.length - 1
      let matchLength = 0
      let lastBoundaryPos = -1
      let atBoundary = false

      // Compare characters from the end
      while (i >= 0 && j >= 0) {
        const urlChar = url[i].toLowerCase()
        const pathChar = path[j]

        // Check if both characters is a path boundary
        const isBoundary = (urlChar === '/' || urlChar === '\\') && (pathChar === '/' || pathChar === '\\' ||
          (j === 1 && pathChar === ':' && WINDOWS_DRIVE_LETTER_REGEX.test(path[0])))

        // If both are boundaries, or if characters match exactly
        if (isBoundary || urlChar === pathChar) {
          if (isBoundary) {
            atBoundary = true
            lastBoundaryPos = matchLength
          } else {
            atBoundary = false
          }
          matchLength++
          i--
          j--
        } else {
          break
        }
      }

      // If we've matched the entire path pattern, ensure it starts at a path boundary
      if (j === -1) {
        if (i >= 0) {
          // If there are more characters in the URL, the next one must be a slash
          if (url[i] === '/' || url[i] === '\\') {
            atBoundary = true
            lastBoundaryPos = matchLength
          }
        } else {
          atBoundary = true
          lastBoundaryPos = matchLength
        }
      }

      // If we found a valid match and it's better than our previous best
      if (atBoundary && (
        lastBoundaryPos > maxMatchLength ||
        (lastBoundaryPos === maxMatchLength && url.length < bestMatch.url.length) // Prefer shorter paths
      )) {
        maxMatchLength = lastBoundaryPos
        bestMatch.url = sourceUrl || url
        bestMatch.scriptId = scriptId
        bestMatch.sourceMapURL = sourceMapURL
        bestMatch.source = source
      }
    }

    return maxMatchLength === -1 ? null : bestMatch
  },

  getStackFromCallFrames (callFrames) {
    return callFrames.map((frame) => {
      // TODO: Possible race condition: If the breakpoint is in the process of being removed, and this is the last
      // breakpoint, it will also stop the debugging session, which in turn will clear the state, which means clearing
      // the `scriptUrls` map. That might result in this the `scriptUrls.get` call above returning `undefined`, which
      // will throw when `startsWith` is called on it.
      let fileName = scriptUrls.get(frame.location.scriptId)
      if (fileName.startsWith('file://')) fileName = fileName.slice(7) // TODO: This might not be required
      return {
        fileName,
        function: frame.functionName,
        lineNumber: frame.location.lineNumber + 1, // Beware! lineNumber is zero-indexed
        columnNumber: frame.location.columnNumber + 1 // Beware! columnNumber is zero-indexed
      }
    })
  },

  // The maps locationToBreakpoint, breakpointToProbes, and probeToLocation are always updated when breakpoints are
  // removed. Therefore they do not need to get manually cleared. Only the state internal to this file needs to be
  // cleared.
  clearState () {
    loadedScripts.length = 0
    scriptUrls.clear()
  }
}

// Known params.url protocols:
// - `node:` - Ignored, as we don't want to instrument Node.js internals
// - `wasm:` - Ignored, as we don't support instrumenting WebAssembly
// - `file:` - Regular on-disk file
// Unknown params.url values:
// - `structured-stack` - Not sure what this is, but should just be ignored
// - `` - Not sure what this is, but should just be ignored
session.on('Debugger.scriptParsed', ({ params }) => {
  scriptUrls.set(params.scriptId, params.url)
  if (params.url.startsWith('file:')) {
    if (params.sourceMapURL) {
      const dir = dirname(new URL(params.url).pathname)
      let sources
      try {
        sources = loadSourceMapSync(dir, params.sourceMapURL).sources
      } catch (err) {
        if (typeof params.sourceMapURL === 'string' && params.sourceMapURL.startsWith('data:')) {
          log.error('[debugger:devtools_client] could not load inline source map for "%s"', params.url, err)
        } else {
          log.error('[debugger:devtools_client] could not load source map "%s" from "%s" for "%s"',
            params.sourceMapURL, dir, params.url, err)
        }
        return
      }
      for (const source of sources) {
        // TODO: Take source map `sourceRoot` into account?
        loadedScripts.push({
          ...params,
          sourceUrl: params.url,
          url: new URL(join(dir, source), 'file:').href,
          // The source url provided by V8 unfortunately doesn't always match the source url used internally in the
          // `source-map` dependency. Both read the same source maps, but the `source-map` dependency iterates over all
          // the `sources` and normalize them using an internal `normalize` function. If these two strings don't match,
          // the `source-map` dependency will not be able to find the generated position. Below we use the same
          // internal `normalize` function, to ensure compatibility.
          // TODO: Consider swapping out the `source-map` dependency for something better so we don't have to do this.
          source: normalize(source)
        })
      }
    } else {
      loadedScripts.push(params)
    }

    if (reEvaluateProbesTimer === null) {
      reEvaluateProbesTimer = setTimeout(() => {
        session.emit('scriptLoadingStabilized')
      }, 500).unref()
    } else {
      reEvaluateProbesTimer.refresh()
    }
  }
})
