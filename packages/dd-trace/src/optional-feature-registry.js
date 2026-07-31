'use strict'

const optionalFeatures = {}

function registerOptionalFeature (feature) {
  optionalFeatures[feature.name] = feature
}

module.exports = { optionalFeatures, registerOptionalFeature }
