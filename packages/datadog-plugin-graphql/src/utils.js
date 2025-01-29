function extractErrorIntoSpanEvent (config, span, exc) {
  const attributes = {}

  if (exc.name) {
    attributes.type = exc.name
  }

  if (exc.stack) {
    attributes.stacktrace = exc.stack
  }

  if (exc.locations) {
    attributes.locations = []
    for (const location of exc.locations) {
      attributes.locations.push(`${location.line}:${location.column}`)
    }
  }

  if (exc.path) {
    attributes.path = exc.path.map(String)
  }

  if (exc.message) {
    attributes.message = exc.message
  }

  if (config.graphqlErrorExtensions) {
    for (const ext of config.graphqlErrorExtensions) {
      if (exc.extensions?.[ext]) {
        attributes[`extensions.${ext}`] = exc.extensions[ext].toString()
      }
    }
  }

  span.addEvent('dd.graphql.query.error', attributes, Date.now())
}

module.exports = {
  extractErrorIntoSpanEvent
}
