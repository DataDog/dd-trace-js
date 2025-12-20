'use strict'

// Orchestrion cannot be used for postgres because the Query class extends Promise
// and its then() method uses 'super.then()' which breaks when orchestrion rewrites it.
// Use shimmer wrapping instead - see packages/datadog-instrumentations/src/postgres.js

module.exports = []
