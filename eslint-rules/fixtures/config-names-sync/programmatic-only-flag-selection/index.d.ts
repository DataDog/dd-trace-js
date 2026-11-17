declare namespace tracer {
  export interface TracerOptions {
    featureFlags?: {
      /**
       * @env DD_FEATURE_FLAGS_EVALUATION_TELEMETRY_PER_SUBJECT_OPT_OUT_ENABLED
       */
      enableEvaluationTelemetryOptOutParameter?: boolean

      flagSelection?: {
        tags?: string[]
        keyPatterns?: string[]
      }
    }
  }
}
