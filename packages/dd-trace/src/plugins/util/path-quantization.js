'use strict'

// Segments made up only of letters, hyphens and underscores carry no
// request-specific value, so they survive quantization. Anything containing a
// digit, a special character or a non-ASCII byte is replaced.
const PRESERVED_SEGMENT = /^[A-Za-z_-]+$/

// API version segments (eg. `v1`) are kept despite containing digits.
const API_VERSION_SEGMENT = /^v[0-9]+$/

// Matches the placeholder used by `http.path_group` and by the Java and Ruby
// tracers, so the same request quantizes identically across languages.
const PLACEHOLDER = '?'

/**
 * @param {number} code character code of a single hex digit
 * @returns {number} its value, or -1 when the character is not a hex digit
 */
function hexValue (code) {
  if (code >= 48 && code <= 57) return code - 48 // 0-9
  if (code >= 65 && code <= 70) return code - 55 // A-F
  if (code >= 97 && code <= 102) return code - 87 // a-f
  return -1
}

/**
 * Percent-decode a single path segment so that an encoded but otherwise
 * unremarkable segment (eg. `%68ello`) is not quantized purely for being
 * encoded.
 *
 * Decoding one segment at a time is deliberate: decoding the whole path first
 * would turn an encoded `%2F` into a separator and invent path structure that
 * the request never had.
 *
 * Invalid escapes are emitted verbatim rather than throwing, so this never
 * needs a caller-side guard. Multi-byte UTF-8 escapes decode to individual
 * bytes, which is harmless here because any byte above ASCII fails
 * `PRESERVED_SEGMENT` and the segment is replaced before it can be emitted.
 *
 * @param {string} segment raw path segment
 * @returns {string} the decoded segment
 */
function decodeSegment (segment) {
  if (!segment.includes('%')) return segment

  let decoded = ''

  for (let i = 0; i < segment.length; i++) {
    if (segment[i] === '%' && i + 2 < segment.length) {
      const high = hexValue(segment.charCodeAt(i + 1))
      const low = hexValue(segment.charCodeAt(i + 2))

      if (high !== -1 && low !== -1) {
        decoded += String.fromCharCode(high * 16 + low)
        i += 2
        continue
      }
    }

    decoded += segment[i]
  }

  return decoded
}

/**
 * Quantize an HTTP request path into a more generic form that resembles a
 * route, replacing segments that carry request-specific values.
 *
 * This is intentionally separate from `calculateHttpEndpoint` in `./url`, which
 * computes the server-side `http.endpoint` grouping key: that one caps the
 * segment count and classifies segments by type (`{param:int}` and friends),
 * because it optimizes for low cardinality rather than for a resource name that
 * still reads like the request that was made.
 *
 * The path must already have its query string and fragment removed. Stripping
 * them here would truncate an already-quantized path at its first `?`
 * placeholder, so re-quantizing would not be a no-op.
 *
 * @param {string} path query-stripped request path
 * @returns {string} the quantized path, always rooted at `/`
 */
function quantizePath (path) {
  if (!path || path === '/') return '/'

  const segments = path.split('/')
  let quantized = ''

  for (let i = 0; i < segments.length; i++) {
    const segment = decodeSegment(segments[i])

    if (i > 0) quantized += '/'

    quantized += segment === '' || PRESERVED_SEGMENT.test(segment) || API_VERSION_SEGMENT.test(segment)
      ? segment
      : PLACEHOLDER
  }

  return quantized.startsWith('/') ? quantized : `/${quantized}`
}

/**
 * Build an HTTP client span's resource name, appending a quantized path when
 * the feature is enabled.
 *
 * @param {string} method upper-cased HTTP method
 * @param {string} path query-stripped request path
 * @param {boolean} [enabled] whether quantization is enabled
 * @returns {string} the resource name
 */
function clientResourceName (method, path, enabled) {
  if (!enabled) return method

  return `${method} ${quantizePath(path)}`
}

module.exports = {
  clientResourceName,
  quantizePath,
}
