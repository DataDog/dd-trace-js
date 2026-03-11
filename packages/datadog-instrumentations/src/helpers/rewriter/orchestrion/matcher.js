'use strict'

/* eslint-disable camelcase */

const semifies = require('../../../../../../vendor/dist/semifies')
const { Transformer } = require('./transformer')

// TODO: addTransform

class InstrumentationMatcher {
  #configs = []
  #dc_module = null
  #transformers = {}

  constructor (configs, dc_module) {
    this.#configs = configs
    this.#dc_module = dc_module || 'diagnostics_channel'
  }

  free () {
    this.#transformers = {}
  }

  getTransformer (module_name, version, file_path) {
    const id = `${module_name}/${file_path}@${version}`

    if (this.#transformers[id]) return this.#transformers[id]

    const configs = this.#configs.filter(({ module: { name, filePath, versionRange } }) =>
      name === module_name &&
      filePath === file_path &&
      semifies(version, versionRange)
    )

    if (configs.length === 0) return

    this.#transformers[id] = new Transformer(
      module_name,
      version,
      file_path,
      configs,
      this.#dc_module
    )

    return this.#transformers[id]
  }
}

module.exports = { InstrumentationMatcher }
