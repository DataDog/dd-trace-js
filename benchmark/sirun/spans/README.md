This test initializes a tracer with the no-op scope manager. It then creates
100000 spans, and depending on the variant, either finishes all of them as they
are created, or later on once they're all created. Prior to creating any spans,
it modifies the processor instance so that no span processing (or exporting) is
done, and it simply stops storing the spans.
