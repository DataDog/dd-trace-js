'use strict'

// In PM2 cluster mode, per-app env vars arrive as a `pm2_env`
// JSON string after --require has already run so we extract them
// manually if present.
var pm2EnvStr = process.env.pm2_env
if (typeof pm2EnvStr === 'string') {
  try {
    var pm2Config = JSON.parse(pm2EnvStr)
    var pm2Keys = Object.keys(pm2Config)
    for (var i = 0; i < pm2Keys.length; i++) {
      var k = pm2Keys[i]
      var v = pm2Config[k]
      if (v != null) {
        process.env[k] = String(v)
      }
    }
  } catch (e) {}
}

var guard = require('./packages/dd-trace/src/guardrails')

module.exports = guard(function () {
  return require('.').init()
})
