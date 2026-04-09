declare namespace tracer {
  export interface TracerOptions {
    /**
     * @env DD_SIMPLE
     */
    simple?: string

    /**
     * @env DD_TRACE_TELEMETRY_ENABLED
     */
    telemetry?: {
      exporter?: {
        /**
         * @env DD_TELEMETRY_EXPORTER_URL
         */
        url?: string
      }
    }
  }
}
