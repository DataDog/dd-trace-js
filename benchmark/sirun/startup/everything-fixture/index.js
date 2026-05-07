'use strict'

// Self-contained "realistic Node.js application" load surface. The startup
// EVERYTHING variants `require()` this module after the tracer has been
// initialised so we measure the cost of the loader hooks (RITM/IITM) firing
// across a representative dependency set. Adding/removing a package only
// requires updating package.json (and refreshing package-lock.json with
// `npm install`); the require list is derived from the manifest below.

const { dependencies } = require('./package.json')

for (const name of Object.keys(dependencies)) {
  require(name)
}
