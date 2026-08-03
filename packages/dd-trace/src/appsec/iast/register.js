'use strict'

const { registerOptionalFeature } = require('../../optional-feature-registry')

registerOptionalFeature({
  name: 'iast',
  factory: () => require('./index'),
})
