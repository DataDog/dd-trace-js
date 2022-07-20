const shimmer = require('../../../../datadog-shimmer')
const Module = require('module')
const { Rewriter } = require('./rewritter')
const { sep } = require('path')
const excludeNodeModules = process.env.DD_CSI_EXCLUDE_NODE_MODULES === 'true'

function includeModule (filename) {
  const isDDTraceFile = filename.indexOf(sep + 'dd-trace-js' + sep) !== -1
  if (!isDDTraceFile) {
    if (!excludeNodeModules || filename.indexOf(sep + 'node_modules' + sep) === -1) {
      return true
    }
  }
  return false
}

// TODO Pending to implement all taint tracking
function twoItemsPlusOperator (a, b) {
  return a + b
}
function threeItemsPlusOperator (a, b, c) {
  return a + b + c
}

function fourItemsPlusOperator (a, b, c, d) {
  return a + b + c + d
}

function fiveItemsPlusOperator (a, b, c, d, e) {
  return a + b + c + d + e
}

function anyPlusOperator () {
  let result = arguments[0]
  for (let i = 1; i < arguments.length; i++) {
    result += arguments[i]
  }
  // TODO Implement taint tracking here
  return result
}
const Propagation = {
  twoItemsPlusOperator,
  threeItemsPlusOperator,
  fourItemsPlusOperator,
  fiveItemsPlusOperator,
  anyPlusOperator,
  templateLiteralOperator: anyPlusOperator
}
function init () {
  if (!global._ddappsec) {
    Object.defineProperty(global, '_ddappsec', {
      value: Propagation,
      enumerable: false,
      configurable: true,
      writable: true
    })
  }
  shimmer.wrap(Module.prototype, '_compile', function (compile) {
    const rewriter = new Rewriter()
    return function (content, filename) {
      let source = content
      if (includeModule(filename)) {
        source = rewriter.rewrite(content, filename)
      }
      return compile.apply(this, [source, filename])
    }
  })
}

module.exports = { init }
