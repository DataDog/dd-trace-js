declare namespace tracer {
  export interface TracerOptions {
    /**
     * @env DD_SIMPLE
     */
    simple?: string

    objectOnly?: {
      /**
       * @env DD_OBJECT_ONLY_ENABLED
       */
      enabled?: boolean
    }

    appsec?: boolean | {
      /**
       * @env DD_APPSEC_ENABLED
       */
      enabled?: boolean
    }

    experimental?: {
      appsec?: boolean | TracerOptions['appsec']

      iast?: boolean | IastOptions
    }
  }

  interface IastOptions {
    /**
     * @env DD_IAST_ENABLED
     */
    enabled?: boolean
  }
}
