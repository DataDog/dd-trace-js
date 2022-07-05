declare const tags: {
  SERVICE_NAME: 'service.name'
  RESOURCE_NAME: 'resource.name'
  SPAN_TYPE: 'span.type'
  SPAN_KIND: 'span.kind'
  SAMPLING_PRIORITY: 'sampling.priority'
  ANALYTICS: '_dd1.sr.eausr'
  ERROR: 'error'
  MANUAL_KEEP: 'manual.keep'
  MANUAL_DROP: 'manual.drop'
  MEASURED: '_dd.measured'
  HTTP_URL: 'http.url'
  HTTP_METHOD: 'http.method'
  HTTP_STATUS_CODE: 'http.status_code'
  HTTP_ROUTE: 'http.route'
  HTTP_REQUEST_HEADERS: 'http.request.headers'
  HTTP_RESPONSE_HEADERS: 'http.response.headers'
  HTTP_USERAGENT: 'http.useragent',
  HTTP_CLIENT_IP: 'http.client_ip'
}

export = tags
