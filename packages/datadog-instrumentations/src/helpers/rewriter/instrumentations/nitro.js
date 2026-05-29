'use strict'

// Nitro v3 / h3 v2 publish native Node.js TracingChannel events on
// `tracingChannel('h3.request')`. We do not rely on orchestrion-driven
// rewrites — the channel-based subscription is handled by the plugin
// directly. This config file exists for symmetry with other integrations
// and may be used to declare future orchestrion-based instrumentation
// points if h3/nitro adds them.
module.exports = []
