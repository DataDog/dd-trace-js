const { PAYLOAD_TAGGING_PREFIX, PAYLOAD_TAGGING_DEPTH } = require('./constants')

const redactedKeys = [
  'authorization', 'x-authorization', 'password', 'token'
]
const truncated = '_dd_truncated_'
const redacted = 'redacted'

function escapeKey (key) {
  return key.replaceAll('.', '\\.')
}

function isJSONContentType (contentType) {
  return contentType && typeof contentType === 'string' && contentType.slice(-4) === 'json'
}

function tagsFromObject (object, filter) {
  const result = {}

  function tagRec (prefix, object, filterObj = filter.filterObj, depth = 0) {
    console.log(filterObj)

    if (depth >= PAYLOAD_TAGGING_DEPTH && typeof object === 'object') {
      result[prefix] = truncated
      return
    } else {
      depth += 1
    }

    if (object === null) {
      // TODO check which tracers strip null/None/... values
      // Probably all of them
      // Limitation to document for users
      result[prefix] = 'null'
      return
    }

    if (typeof object === 'number' || typeof object === 'boolean') {
      result[prefix] = object.toString()
      return
    }

    if (typeof object === 'string') {
      const lastKey = prefix.split('.').pop()
      result[prefix] = redactedKeys.includes(lastKey) ? redacted : object.substring(0, 5000)
      return
    }

    if (typeof object === 'object') {
      for (const [key, value] of Object.entries(object)) {
        if (!filter.canTagValue(key, filterObj)) continue
        filterObj = filterObj === undefined ? filterObj : filterObj[key]
        tagRec(`${prefix}.${escapeKey(key)}`, value, filterObj, depth)
      }
    }
  }
  tagRec(PAYLOAD_TAGGING_PREFIX, object)
  return result
}

function acceptedObject (filterStr) {
  if (filterStr === '*') return new Filter(undefined, true, true)

  const items = filterStr.split(',')

  function assignPath (obj, pathKeys) {
    const finalKey = pathKeys.pop()
    for (const key of pathKeys) {
      obj = obj[key] = obj[key] || {}
    }
    obj[finalKey] = true
  }

  const filterObj = {}
  if (filterStr.startsWith('*')) {
    const excludes = items.slice(1).map(exclude => exclude.slice(1).split('.'))
    for (const include of excludes) {
      assignPath(filterObj, include)
    }
    return new Filter(filterObj, true)
  } else {
    const excludes = items.slice(1).map(include => include.split('.'))
    for (const exclude of excludes) {
      assignPath(filterObj, exclude)
    }
    return new Filter(filterObj, false)
  }
}

class Filter {
  constructor (filterObj, isExclusionFilter, isGlob = false) {
    this._filterObj = filterObj
    this._isExclusionFilter = isExclusionFilter
    this._isGlob = isGlob
  }

  get filterObj () {
    return this._filterObj
  }

  get isExclusionFilter () {
    return this._isExclusionFilter
  }

  canTagValue (key, currentFilter) {
    if (currentFilter) { console.log(`can tag key ${key} given ${JSON.stringify(currentFilter)}`) }
    if (this._isGlob) return true
    if (currentFilter === undefined) {
      return !this.isExclusionFilter
    }
    if (this.isExclusionFilter) {
      return currentFilter[key] !== true
    } else {
      return currentFilter.hasOwnProperty(key)
    }
  }
}

function toTags (jsonString, contentType, filter = '*') {
  if (!isJSONContentType(contentType)) {
    return {}
  }
  let object
  try {
    object = JSON.parse(jsonString)
  } catch (err) {
    return {}
  }

  const filterObj = acceptedObject(filter)
  return tagsFromObject(object, filterObj)
}

module.exports = toTags
