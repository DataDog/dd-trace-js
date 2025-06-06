'use strict'

const tagger = {
  parse (tags) {
    if (!tags) return {}

    switch (typeof tags) {
      case 'object': {
        if (Array.isArray(tags)) {
          const tagObject = {}
          for (const tag of tags) {
            const colon = tag.indexOf(':')
            if (colon === -1) continue
            const key = tag.slice(0, colon).trim()
            const value = tag.slice(colon + 1).trim()
            if (key.length !== 0 && value.length !== 0) {
              tagObject[key] = value
            }
          }
          return tagObject
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
