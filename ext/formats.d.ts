import * as opentracing from 'opentracing'

declare const formats: {
  TEXT_MAP: typeof opentracing.FORMAT_TEXT_MAP
  HTTP_HEADERS: typeof opentracing.FORMAT_HTTP_HEADERS
  BINARY: typeof opentracing.FORMAT_BINARY
  LOG: 'log'
}

export = formats
