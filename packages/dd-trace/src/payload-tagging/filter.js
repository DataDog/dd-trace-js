function filterFromString (filterStr) {
  if (filterStr === undefined) return undefined

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
    for (const exclude of excludes) {
      assignPath(filterObj, exclude)
    }
    return new Filter(filterObj, true)
  } else {
    const includes = items.map(include => include.split('.'))
    for (const include of includes) {
      assignPath(filterObj, include)
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

  canTag (key, currentFilter) {
    if (this._isGlob) return true
    if (currentFilter === undefined) {
      return !this.isExclusionFilter
    }
    if (this.isExclusionFilter) {
      return currentFilter[key] !== true
    } else {
      return currentFilter.hasOwnProperty(key) || currentFilter === true
    }
  }
}

module.exports = { filterFromString }
