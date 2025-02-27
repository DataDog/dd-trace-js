class SpanFilter {
  constructor (predefinedFilters) {
    this.filters = this.compileFilters(predefinedFilters)
    this.cache = new Map()
  }

  compileFilters (predefinedFilters) {
    return predefinedFilters.map(filter => {
      const tagSet = new Set(filter.criteria.tags)
      return { type: filter.type, tagSet }
    })
  }

  generateCacheKey (ctx) {
    // For simplicity, use service and a sorted list of tag keys
    const tagKeys = Object.keys(ctx._tags).sort()
    return `${ctx._tags.service}|${tagKeys.join(',')}`
  }

  shouldKeepSpan (ctx) {
    const cacheKey = this.generateCacheKey(ctx)
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)
    }

    for (const filter of this.filters) {
      switch (filter.type) {
        case 'service':
          if (!filter.tagSet.has(ctx._tags.service)) {
            this.cache.set(cacheKey, false)
            return false
          }
          break
        case 'tag':
          for (const tag of filter.tagSet) {
            if (!ctx._tags[tag]) {
              this.cache.set(cacheKey, false)
              return false
            }
          }
          break
          // Add more cases as needed
      }
    }

    this.cache.set(cacheKey, true)
    return true
  }
}

// Usage
const predefinedFilters = [
  // {
  //   type: 'service',
  //   criteria: { tags: ['my-service', 'express-app'] }
  // },
  {
    type: 'tag',
    criteria: { tags: ['span.kind'] }
  }
  // More filters
]

const spanFilter = new SpanFilter(predefinedFilters)

module.exports = {
  spanFilter
}
