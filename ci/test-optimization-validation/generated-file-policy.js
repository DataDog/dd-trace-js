'use strict'

const { hasUnsafeInvisibleCharacter, sanitizeString } = require('./redaction')

const MAX_GENERATED_FILES = 8
const MAX_GENERATED_FILE_BYTES = 32 * 1024
const MAX_GENERATED_FILE_LINES = 256
const MAX_GENERATED_LINE_BYTES = 4096

/**
 * Returns why generated source is unsafe to write and execute.
 *
 * @param {unknown} contentLines generated source lines
 * @returns {string|undefined} policy violation
 */
function getGeneratedFileContentError (contentLines) {
  if (!Array.isArray(contentLines) || contentLines.some(line => typeof line !== 'string')) return
  if (contentLines.length > MAX_GENERATED_FILE_LINES) {
    return `must contain at most ${MAX_GENERATED_FILE_LINES} lines`
  }

  let totalBytes = 1
  for (const line of contentLines) {
    if (line.includes('\n') || line.includes('\r') || hasUnsafeControlCharacter(line)) {
      return 'must use one printable source line per contentLines entry'
    }
    if (Buffer.byteLength(line) > MAX_GENERATED_LINE_BYTES) {
      return `must not contain a line larger than ${MAX_GENERATED_LINE_BYTES} bytes`
    }
    if (sanitizeString(line) !== line) {
      return 'must contain only synthetic source and no secret-like values'
    }
    totalBytes += Buffer.byteLength(line) + 1
  }

  if (totalBytes > MAX_GENERATED_FILE_BYTES) {
    return `must be at most ${MAX_GENERATED_FILE_BYTES} bytes`
  }

  const source = contentLines.join('\n')
  if (/\bwriteFileSync\s*\(/.test(source) && /\bnew\s+URL\s*\(/.test(source) &&
    !/\bfileURLToPath\s*\(/.test(source)) {
    return 'must convert generated state-file URLs with fileURLToPath before passing them to writeFileSync'
  }
}

function hasUnsafeControlCharacter (value) {
  if (hasUnsafeInvisibleCharacter(value)) return true

  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x08 || code === 0x0B || code === 0x0C || (code >= 0x0E && code <= 0x1F) ||
      code === 0x7F) {
      return true
    }
  }
  return false
}

module.exports = {
  MAX_GENERATED_FILES,
  getGeneratedFileContentError,
}
