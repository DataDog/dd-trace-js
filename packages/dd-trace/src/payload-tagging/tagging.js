const { PAYLOAD_TAGGING_MAX_TAGS } = require('../constants')

const redactedKeys = [
  'authorization', 'x-authorization', 'password', 'token'
]
const truncated = 'truncated'
const redacted = 'redacted'

function escapeKey (key) {
  return key.replaceAll('.', '\\.')
}

/**
   * Compute normalized payload tags from any given object.
   *
   * @param {object} object
   * @param {import('./mask').Mask} mask
   * @param {number} maxDepth
   * @param {string} prefix
   * @returns
   */
function tagsFromObject (object, opts) {
  const { maxDepth, prefix } = opts

  let tagCount = 0
  let abort = false
  const result = {}

  function tagRec (prefix, object, depth = 0) {
    // Off by one: _dd.payload_tags_trimmed counts as 1 tag
    if (abort) { return }

    if (tagCount >= PAYLOAD_TAGGING_MAX_TAGS - 1) {
      abort = true
      result['_dd.payload_tags_incomplete'] = true
      return
    }

    if (depth >= maxDepth && typeof object === 'object') {
      tagCount += 1
      result[prefix] = truncated
      return
    }

    if (object === undefined) {
      tagCount += 1
      result[prefix] = 'undefined'
      return
    }

    if (object === null) {
      tagCount += 1
      result[prefix] = 'null'
      return
    }

    if (['number', 'boolean'].includes(typeof object) || Buffer.isBuffer(object)) {
      tagCount += 1
      result[prefix] = object.toString().substring(0, 5000)
      return
    }

    if (typeof object === 'string') {
      tagCount += 1
      result[prefix] = object.substring(0, 5000)
    }

    if (typeof object === 'object') {
      for (const [key, value] of Object.entries(object)) {
        if (redactedKeys.includes(key.toLowerCase())) {
          tagCount += 1
          result[`${prefix}.${escapeKey(key)}`] = redacted
        } else {
          tagRec(`${prefix}.${escapeKey(key)}`, value, depth + 1)
        }
      }
    }
  }
  tagRec(prefix, object)
  return result
}

module.exports = { tagsFromObject }
