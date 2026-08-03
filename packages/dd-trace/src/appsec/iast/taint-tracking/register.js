'use strict'

const { registerOptionalFeature } = require('../../../optional-feature-registry')

registerOptionalFeature({
  name: 'rewriter',
  factory: () => require('./rewriter'),
})
