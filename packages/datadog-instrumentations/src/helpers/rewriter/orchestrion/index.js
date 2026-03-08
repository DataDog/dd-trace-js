'use strict'

/*
This folder is basically a JavaScript version of Orchestrion-JS. The goal is
not to replace Orchestrion-JS, but rather to make it easier and faster to write
new integrations in the short-term, especially as many changes to the rewriter
will be needed as all the patterns we need have not been identified yet. This
will avoid the back and forth of having to make Rust changes to an external
library for every integration change or addition that requires something new.

In the meantime, we'll work concurrently on a change to Orchestrion-JS that
adds an "arbitrary transform" or "plugin" system that can be used from
JavaScript, in order to enable quick iteration while still using Orchestrion-JS.
Once that's done we'll use that, so that we can remove this JS approach and
return to using Orchestrion-JS.

The long term goal is to backport any additional features we add to the JS
rewriter (or using the plugin system in Orchestrion-JS once we're using that)
to Orchestrion-JS  once we're confident that the implementation is fairly
complete and has all features we need.

Here is a list of the additions and changes in this rewriter compared to
Orchestrion-JS that will need to be backported:

(NOTE: Please keep this list up-to-date whenever new features are added)

- Supports an `astQuery` field to filter AST nodes with an esquery query. This
  is mostly meant to be used when experimenting or if what needs to be queried
  is not a function. We'll see over time if something like this is needed to be
  backported or if it can be replaced by simpler queries.
- Supports replacing methods of child class instances in the base constructor.
- Supports tracing iterator (sync/async) returning functions (sync/async).
*/

/* eslint-disable camelcase */

const { InstrumentationMatcher } = require('./matcher')

function create (configs, dc_module) {
  return new InstrumentationMatcher(configs, dc_module)
}

module.exports = { create }
