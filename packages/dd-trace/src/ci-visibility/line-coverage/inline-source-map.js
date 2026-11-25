'use strict'

const INLINE_SOURCE_MAP_COMMENT = '//# sourceMappingURL=data:application/json'
const BASE64_DATA = /^(?:;charset=[\w-]+)?;base64,([\d+/A-Za-z]+={0,2})/

/**
 * Returns the source map a transformer appended to a module as a data URL comment, as JSON text.
 *
 * @param {string} code
 * @returns {string | undefined}
 */
function getInlineSourceMap (code) {
  const start = code.lastIndexOf(INLINE_SOURCE_MAP_COMMENT)
  if (start === -1) return
  const encoded = BASE64_DATA.exec(code.slice(start + INLINE_SOURCE_MAP_COMMENT.length))?.[1]
  if (encoded) return Buffer.from(encoded, 'base64').toString()
}

module.exports = { getInlineSourceMap }
