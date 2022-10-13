'use strict'

const CompositePlugin = require('../../dd-trace/src/plugins/composite')
const DNSLookupPlugin = require('./lookup')
const DNSLookupServicePlugin = require('./lookup_service')
const DNSResolvePlugin = require('./resolve')
const DNSReversePlugin = require('./reverse')

// TODO: Are DNS spans really client spans?

class DNSPlugin extends CompositePlugin {
  static get name () { return 'dns' }
  static get plugins () {
    return {
      lookup: DNSLookupPlugin,
      lookup_service: DNSLookupServicePlugin,
      resolve: DNSResolvePlugin,
      reverse: DNSReversePlugin
    }
  }
}

module.exports = DNSPlugin
