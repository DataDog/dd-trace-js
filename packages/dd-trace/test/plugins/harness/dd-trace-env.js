'use strict'

const tracer = require('../../../../../dd-trace-js')
tracer.init()

const NodeEnvironment = require('jest-environment-node')
const path = require('path')
const parse = require('module-details-from-path')

const EVAL_RESULT_VARIABLE = 'Object.<anonymous>'

class TracerEnvironment extends NodeEnvironment {
constructor (config, context) {
    super(config, context)
  }

  async setup() {
    await super.setup()
  }

  async teardown() {
    await super.teardown()
  }

  runScript (script) {
    const scriptObj = super.runScript(script)
    const orig = scriptObj[EVAL_RESULT_VARIABLE]

    scriptObj[EVAL_RESULT_VARIABLE] = function (_module, exports, require, dirname, filename, global, jest) {
      const ret = orig.apply(this, arguments)
      const module_details = parse(filename)

      const moduleExports = _module.exports
      const moduleBaseDir = module_details.basedir
      const moduleName = path.join(module_details.name, module_details.path)

      const patchedExports = tracer._instrumenter.hookModule(moduleExports, moduleName, moduleBaseDir)

      Object.defineProperty(_module, 'exports', { value: patchedExports })

      return ret
    }

    return scriptObj
  }
}

module.exports = TracerEnvironment
