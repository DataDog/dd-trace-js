


class SpanFilter {
  constructor (tracer) {
    let predefinedFilters = []
    if (tracer._config.traceLevel === 'service') {
      predefinedFilters = traceLevelServiceFilters
    }
    // Load filters from environment variables
    const envFilters = this.parseEnvFilters(process.env.DD_SPAN_FILTERS || '')
    // Combine predefined and environment filters
    this.filters = this.compileFilters([...predefinedFilters, ...envFilters])
    this.cache = new Map()
  }

  /**
   * Parses the SPAN_FILTERS environment variable into filter objects.
   * Format: "field1[:value1],field2[:value2];field3[:value3],..."
   * Example: "service=my-service,resource;tag:span.kind=server,tag:env"
   */
  parseEnvFilters (envString) {
    const filters = []
    const rawFilters = envString.split(';').map(f => f.trim()).filter(f => f)

    rawFilters.forEach(rawFilter => {
      const criteriaStrings = rawFilter.split(',').map(c => c.trim()).filter(c => c)
      const criteria = {}

      criteriaStrings.forEach(criteriaStr => {
        const [fieldWithOptionalPrefix, value] = criteriaStr.split('=').map(s => s.trim())

        // Check if field is a tag (e.g., tag:span.kind)
        if (fieldWithOptionalPrefix.startsWith('tag:')) {
          const tagKey = fieldWithOptionalPrefix.slice(4)
          if (!criteria.tags) criteria.tags = []
          if (value) {
            criteria.tags.push({ key: tagKey, value })
          } else {
            criteria.tags.push({ key: tagKey })
          }
        } else {
          // It's a regular field (service, resource, name)
          const field = fieldWithOptionalPrefix
          if (!criteria[field]) criteria[field] = []
          if (value) {
            criteria[field].push(value)
          } else {
            criteria[field].push(null) // null signifies presence check
          }
        }
      })

      filters.push(criteria)
    })

    return filters
  }

  /**
   * Compiles the filter criteria into a structured format for efficient matching.
   */
  compileFilters (predefinedFilters) {
    return predefinedFilters.map(filter => {
      const compiled = {}
      // Compile service filters
      if (filter.service) {
        compiled.service = new Set(filter.service)
      }
      // Compile resource filters
      if (filter.resource) {
        compiled.resource = new Set(filter.resource)
      }
      // Compile name filters
      if (filter.name) {
        compiled.name = new Set(filter.name)
      }
      // Compile tag filters
      if (filter.tags) {
        // Separate tags with values and tags without values
        compiled.tagsWithValue = new Map()
        compiled.tagsWithoutValue = new Set()

        filter.tags.forEach(tag => {
          if (tag.value) {
            if (!compiled.tagsWithValue.has(tag.key)) {
              compiled.tagsWithValue.set(tag.key, new Set())
            }
            compiled.tagsWithValue.get(tag.key).add(tag.value)
          } else {
            compiled.tagsWithoutValue.add(tag.key)
          }
        })
      }
      return compiled
    })
  }

  /**
   * Generates a cache key based on relevant span fields.
   */
  generateCacheKey (span) {
    const { [service.name], resource, name, tags } = span
    // Extract tag keys and sort them for consistency
    const tagKeys = Object.keys(tags || {}).sort()
    return `service:${service}|resource:${resource}|name:${name}|tags:${tagKeys.join(',')}`
  }

  /**
   * Determines whether to keep a span based on the compiled filters.
   */
  shouldKeepSpan (span) {
    const cacheKey = this.generateCacheKey(span)
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)
    }

    // Iterate through all filters; if span matches any filter, determine accordingly
    let keep = false

    for (const filter of this.filters) {
      let matches = true

      // Check service
      if (filter.service) {
        if (!span.service || !filter.service.has(span.service)) {
          matches = false
        }
      }

      // Check resource
      if (matches && filter.resource) {
        if (!span.resource || !filter.resource.has(span.resource)) {
          matches = false
        }
      }

      // Check name
      if (matches && filter.name) {
        if (!span.name || !filter.name.has(span.name)) {
          matches = false
        }
      }

      // Check tags
      if (matches && filter.tagsWithValue) {
        for (const [key, values] of filter.tagsWithValue.entries()) {
          if (!span.tags || !span.tags[key] || !values.has(span.tags[key])) {
            matches = false
            break
          }
        }
      }
      if (matches && filter.tagsWithoutValue) {
        for (const key of filter.tagsWithoutValue) {
          if (!span.tags || !span.tags[key]) {
            matches = false
            break
          }
        }
      }

      if (matches) {
        keep = true
        break // Stop at first matching filter
      }
    }

    this.cache.set(cacheKey, keep)
    return keep
  }
}

// Example Usage

// Predefined filters can still be passed programmatically
const traceLevelServiceFilters = [
  // {
  //   service: ['my-service', 'express-app'] // Match service equal to 'my-service' or 'express-app'
  // },
  {
    tags: [{ key: 'span.kind' }]
  }
]

module.exports = {
  SpanFilter
}
