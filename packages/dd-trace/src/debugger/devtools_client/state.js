'use strict'

const { join, dirname } = require('path')
const { loadSourceMapSync } = require('./source-maps')
const session = require('./session')
const log = require('../../log')

const WINDOWS_DRIVE_LETTER_REGEX = /[a-zA-Z]/

const loadedScripts = []
const scriptUrls = new Map()

module.exports = {
  probes: new Map(),
  breakpoints: new Map(),

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

    return maxMatchLength > -1 ? bestMatch : null
  },

  getStackFromCallFrames (callFrames) {
    return callFrames.map((frame) => {
      let fileName = scriptUrls.get(frame.location.scriptId)
      if (fileName.startsWith('file://')) fileName = fileName.substr(7) // TODO: This might not be required
      return {
        fileName,
        function: frame.functionName,
        lineNumber: frame.location.lineNumber + 1, // Beware! lineNumber is zero-indexed
        columnNumber: frame.location.columnNumber + 1 // Beware! columnNumber is zero-indexed
      }
    })
  }
}

// Known params.url protocols:
// - `node:` - Ignored, as we don't want to instrument Node.js internals
// - `wasm:` - Ignored, as we don't support instrumenting WebAssembly
// - `file:` - Regular on-disk file
// Unknown params.url values:
// - `structured-stack` - Not sure what this is, but should just be ignored
// - `` - Not sure what this is, but should just be ignored
// TODO: Event fired for all files, every time debugger is enabled. So when we disable it, we need to reset the state
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
          source
        })
      }
    } else {
      loadedScripts.push(params)
    }
  }
})
