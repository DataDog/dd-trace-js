import { Module } from 'module'
import * as iitm from './packages/dd-trace/src/loaders/iitm.mjs'
import * as rewriter from './packages/dd-trace/src/appsec/iast/taint-tracking/rewriter-esm.mjs'

// If `Module.register` is supported, the rewriter will be registered later
// once the config object is available so that IAST can use it. This is not
// needed in old versions of Node without `Module.require` because IAST is not
// supported in those versions and for instrumentation we don't need the config
// object so we can just load the hook right away in this file.
const hasRewriter = Module.hasOwnProperty('register')

const initialize = hasRewriter
  ? iitm.initialize
  : function initialize (data) {
    iitm.initialize(data)
    rewriter.initialize(data)
  }

const load = hasRewriter
  ? iitm.load
  : function load (url, context, nextLoad) {
    iitm.load(url, context, (url, context) => rewriter.load(url, context, nextLoad))
  }

export { initialize, load }
export { getFormat, resolve, getSource } from './packages/dd-trace/src/loaders/iitm.mjs'
