const {
  PAYLOAD_TAG_REQUEST_PREFIX: PAYLOAD_REQUEST_PREFIX,
  PAYLOAD_TAG_RESPONSE_PREFIX: PAYLOAD_RESPONSE_PREFIX,
  PAYLOAD_TAGGING_MAX_TAGS
} = require('../constants')

const redactedKeys = [
  'authorization', 'x-authorization', 'password', 'token'
]
const truncated = 'truncated'
const redacted = 'redacted'

function escapeKey (key) {
  return key.replaceAll('.', '\\.')
}

function isJSONContentType (contentType) {
  return typeof contentType === 'string' && contentType.substring(contentType.length - 4) === 'json'
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
function tagsFromObject (object, mask, maxDepth, prefix) {
  let tagCount = 0

  function tagRec (prefix, object, maskHead = mask._root, depth = 0) {
    // Off by one: _dd.payload_tags_trimmed counts as 1 tag
    if (tagCount >= PAYLOAD_TAGGING_MAX_TAGS - 1) {
      tagCount += 1
      return [['_dd.payload_tags_trimmed', true]]
    }

    if (depth >= maxDepth && typeof object === 'object') {
      tagCount += 1
      return [[prefix, truncated]]
    }

    if (object === null) {
      tagCount += 1
      return [[prefix, 'null']]
    }

    if (['number', 'boolean'].includes(typeof object)) {
      tagCount += 1
      return [[prefix, object.toString()]]
    }

    if (typeof object === 'string') {
      tagCount += 1
      return [[prefix, object.substring(0, 5000)]]
    }

    if (typeof object === 'object') {
      const subTags = []
      for (const [key, value] of Object.entries(object)) {
        const isLastKey = !(typeof value === 'object')
        if (redactedKeys.includes(key)) {
          subTags.push(tagRec(`${prefix}.${key}`, redacted, undefined, depth + 1))
          continue
        }
        if (maskHead.canTag(key, isLastKey)) {
          subTags.push(tagRec(`${prefix}.${escapeKey(key)}`, value, maskHead.next(key), depth + 1))
        }
      }
      return subTags.flat()
    }
  }
  return Object.fromEntries(tagRec(prefix, object))
}

function getBodyTags (jsonString, contentType, opts) {
  const {
    filter,
    maxDepth,
    prefix = ''
  } = opts
  if (!isJSONContentType(contentType)) {
    return {}
  }
  let object
  try {
    object = JSON.parse(jsonString)
  } catch (err) {
    return {}
  }

  return tagsFromObject(object, filter, maxDepth, prefix)
}

function getBodyRequestTags (jsonString, contentType, opts) {
  return getBodyTags(jsonString, contentType, { ...opts, prefix: PAYLOAD_REQUEST_PREFIX })
}

function getBodyResponseTags (jsonString, contentType, opts) {
  return getBodyTags(jsonString, contentType, { ...opts, prefix: PAYLOAD_RESPONSE_PREFIX })
}

module.exports = {
  tagsFromObject,
  getBodyTags,
  getBodyRequestTags,
  getBodyResponseTags,
  isJSONContentType
}
