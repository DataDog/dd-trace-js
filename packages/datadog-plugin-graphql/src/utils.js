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
    attributes.path = exc.path
  }

  if (exc.message) {
    attributes.message = exc.message
  }

  if (!config.traceGraphQlErrorExtensions) { // fix ! and config
    config.traceGraphQlErrorExtensions = ['code']
    for (const ext of config.traceGraphQlErrorExtensions) {
      if (exc.extensions?.[ext]) {
        attributes[`extensions.${ext}`] = exc.extensions[ext]
      }
    }
  }

  span.addEvent('dd.graphql.query.error', attributes, Date.now())
}

module.exports = {
  extractErrorIntoSpanEvent
}
