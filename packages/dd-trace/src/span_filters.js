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

  generateCacheKey (spanContext) {
    // For simplicity, use name, service and a sorted list of tag keys
    const tagKeys = Object.keys(spanContext._tags).sort()
    return `${spanContext._tags.service}|${spanContext._name}|${tagKeys.join(',')}`
  }

  shouldKeepSpan (spanContext) {
    const cacheKey = this.generateCacheKey(spanContext)
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)
    }

    for (const filter of this.filters) {
      switch (filter.type) {
        case 'service':
          if (!filter.tagSet.has(spanContext._tags.service)) {
            this.cache.set(cacheKey, false)
            return false
          }
          break
        case 'tag':
          for (const tag of filter.tagSet) {
            if (!spanContext._tags[tag]) {
              this.cache.set(cacheKey, false)
              return false
            }
          }
          break
      }
    }

    this.cache.set(cacheKey, true)
    return true
  }
}

const predefinedFilters = [
//   {
//     type: 'service',
//     criteria: { tags: ['my-service', 'another-service'] }
//   },
  {
    type: 'tag',
    criteria: { tags: ['span.kind'] }
  }
]

const spanFilter = new SpanFilter(predefinedFilters)

function stripSpan (span) {
  span.name = ''
  span.resource = ''
  span.service = ''
  span.start = 0
  span.duration = 0
  span.type = ''
  span.meta = {}
  span.metrics = {}
  span.links = []
}

module.exports = { spanFilter, stripSpan }
