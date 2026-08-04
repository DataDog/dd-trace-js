# plugin-elasticsearch

Measures the Elasticsearch plugin `bindStart`: serialize the request body
(JSON.stringify), quantize the path (digits to `?`), serialize the query string,
and assemble the meta bag. Variants cover a search with a query-DSL body, a bulk
index payload, and a doc get with no body.
