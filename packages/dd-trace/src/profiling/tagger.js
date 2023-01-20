'use strict'

const tagger = {
  parse (tags) {
    if (!tags) return {}

    switch (typeof tags) {
      case 'object':
        if (Array.isArray(tags)) {
          return tags.reduce((prev, next) => {
            const parts = next.split(':')
            const key = parts.shift().trim()
            const value = parts.join(':').trim()

            if (!key || !value) return prev

            return Object.assign(prev, { [key]: value })
          }, {})
        } else {
          return tagger.parse(Object.keys(tags)
            .filter(key => tags[key] !== undefined && tags[key] !== null)
            .map(key => `${key}:${tags[key]}`))
        }
      case 'string':
        return tagger.parse(tags.split(','))
      default:
        return {}
    }
  }
}

module.exports = { tagger }
