'use strict'

const Activation = {
  OneClick: 'OneClick',
  Enabled: 'Enabled',
  Disabled: 'Disabled',

  fromConfig (config) {
    switch (config.appsec.enabled) {
      // ASM is activated by an env var DD_APPSEC_ENABLED=true
      case true:
        return Activation.Enabled

      // ASM is disabled by an env var DD_APPSEC_ENABLED=false
      case false:
        return Activation.Disabled

      // ASM is activated by one click remote config
      case undefined:
        return Activation.OneClick

      // Any other value should never occur
      default:
        return Activation.Disabled
    }
  }
}

module.exports = Activation
