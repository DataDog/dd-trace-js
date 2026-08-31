'use strict'

// In PM2 cluster mode, per-app env vars arrive as a `pm2_env`
// JSON string after preloads have run, so extract them first.
var pm2EnvStr = process.env.pm2_env
if (typeof pm2EnvStr === 'string') {
  try {
    var pm2Config = JSON.parse(pm2EnvStr)
    var pm2Keys = Object.keys(pm2Config)
    for (var i = 0; i < pm2Keys.length; i++) {
      var key = pm2Keys[i]
      var value = pm2Config[key]
      process.env[key] = String(value)
    }
  } catch (error) {}
}
