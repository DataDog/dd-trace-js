'use strict'

const { registerOptionalFeature } = require('../optional-feature-registry')

registerOptionalFeature({
  name: 'appsec',
  factory: () => require('./index'),
})
