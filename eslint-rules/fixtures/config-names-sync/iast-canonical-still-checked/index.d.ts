declare namespace tracer {
  export interface TracerOptions {
    iast?: boolean | {
      /**
       * @env DD_IAST_ENABLED
       */
      enabled?: boolean
    }
  }
}
