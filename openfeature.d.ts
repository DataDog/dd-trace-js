import tracer = require('.')

/**
 * OpenFeature provider that integrates with Datadog's feature flagging system.
 * Must be required after `tracer.init()`.
 *
 * @beta This feature is in preview and not ready for production use
 */
declare const provider: tracer.OpenFeatureProvider

export = provider
