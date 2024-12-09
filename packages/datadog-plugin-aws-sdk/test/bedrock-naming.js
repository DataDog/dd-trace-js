const { resolveNaming } = require('../../dd-trace/test/plugins/helpers')

const rawExpectedSchema = {
  // TODO infer service name and operation name
}

module.exports = {
  rawExpectedSchema,
  expectedSchema: resolveNaming(rawExpectedSchema)
}
