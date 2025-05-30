'use strict'

const tagger = {
  parse (tags) {
    if (!tags) return {}

    switch (typeof tags) {
      case 'object': {
        if (Array.isArray(tags)) {
          return tags.reduce((prev, next) => {
            const parts = next.split(':')
            const key = parts.shift().trim()
            if (!key) return prev

            const value = parts.join(':').trim()
            if (!value) return prev

            prev[key] = value
            return prev
          }, {})
        }

        const tagsArray = []
        for (const [key, value] of Object.entries(tags)) {
          if (value != null) {
            tagsArray.push(`${key}:${value}`)
          }
        }

        return tagger.parse(tagsArray)
      }
      case 'string':
        return tagger.parse(tags.split(','))
      default:
        return {}
    }
  }
}

module.exports = { tagger }
