declare namespace tracer {
  export interface TracerOptions {
    /**
     * @env DD_SIMPLE
     */
    simple?: string

    /**
     * @env DD_MISSING_FROM_JSON
     */
    missingFromJson?: boolean
  }
}
