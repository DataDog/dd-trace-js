declare namespace tracer {
  export interface PropagationStyle {
    /**
     * @env DD_TRACE_PROPAGATION_STYLE, DD_TRACE_PROPAGATION_STYLE_INJECT
     */
    inject: string[]

    /**
     * @env DD_TRACE_PROPAGATION_STYLE, DD_TRACE_PROPAGATION_STYLE_EXTRACT
     */
    extract: string[]
  }

  export interface TracerOptions {
    /**
     * @env DD_TRACE_PROPAGATION_STYLE, DD_TRACE_PROPAGATION_STYLE_INJECT, DD_TRACE_PROPAGATION_STYLE_EXTRACT
     */
    tracePropagationStyle?: string[] | PropagationStyle
  }
}
