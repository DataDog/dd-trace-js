declare namespace tracer {
  export interface TracerOptions {
    /**
     * @env DD_LLMOBS_ENABLED
     * The environment variable listed above takes precedence over programmatic configuration.
     */
    llmobs?: {
      /**
       * @env DD_LLMOBS_ML_APP
       */
      mlApp?: string

      agentlessEnabledasd?: string
    }
  }
}
