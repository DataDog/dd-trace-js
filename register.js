const { register } = require('node:module')
const { pathToFileURL } = require('node:url')

register('./loader-hook.mjs', pathToFileURL(__filename))
