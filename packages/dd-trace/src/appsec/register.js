'use strict'

const { registerOptionalFeature } = require('../optional-feature-registry')

registerOptionalFeature({
  name: 'appsec',
  factory: () => require('./index'),
  // kept separate from `factory` so remote-config registration doesn't force-load the full
  // appsec module (WAF, RASP, etc.) before appsec is actually enabled
  remoteConfigFactory: () => require('./remote_config'),
})
