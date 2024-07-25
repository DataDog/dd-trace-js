const TracingPlugin = require('../../dd-trace/src/plugins/tracing')

class AzureFunctionsPlugin extends TracingPlugin {
  static get id () {
    return 'azure-functions'
  }

  start ({ name, options }) {
    this.startSpan('azure-inbound-web', {
      service: this.config.service || this._tracerConfig.service,
      resource: name,
      type: 'system',
      meta: {
        'azure-functions.name': name,
        'azure-functions.trigger': options.trigger
      }
    }, false)
  }

  end () {
    this.activeSpan?.finish()
  }

  error () {}

  asyncEnd () {
    // should never happen
    console.log("async end");
  }
}

module.exports = AzureFunctionsPlugin