'use strict'

// dd-trace must initialize (and enable source-map support) before the compiled app module loads:
// Node only parses a module's source map when support is on at the time the module is required, and
// it cannot retroactively map the entry module. Requiring ./throws.js after init is what exercises
// flagless remapping — no --enable-source-maps.
require('dd-trace/init')
require('./throws.js')
