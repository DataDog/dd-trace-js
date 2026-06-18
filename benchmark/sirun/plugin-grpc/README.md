# plugin-grpc

Measures the gRPC client plugin `bindStart`: resolve the method metadata from the
`/pkg.Service/Method` path (parsed once per path, then cached) and assemble the
method meta bag. Variants cover a single unary method and a mix of methods from a
typical service definition.
