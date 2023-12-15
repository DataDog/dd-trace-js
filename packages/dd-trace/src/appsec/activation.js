'use strict'

const Activation = {
  ONECLICK: 'OneClick',
  ENABLED: 'Enabled',
  DISABLED: 'Disabled',

  fromConfig (config) {
    switch (config.appsec.enabled) {
      // ASM is activated by an env var DD_APPSEC_ENABLED=true
      case true:
        return Activation.ENABLED

      // ASM is disabled by an env var DD_APPSEC_ENABLED=false
      case false:
        return Activation.DISABLED

      // ASM is activated by one click remote config
      case undefined:
        return Activation.ONECLICK

      // Any other value should never occur
      default:
        return Activation.DISABLED
    }
  }
}

module.exports = Activation
