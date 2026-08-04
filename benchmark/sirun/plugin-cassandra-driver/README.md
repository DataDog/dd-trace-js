# plugin-cassandra-driver

Measures the cassandra-driver plugin `bindStart`: combine a batch of statements
into a single resource string (or trim a single long statement at 5000 chars) and
assemble the meta bag. Variants cover a single query, a batch, and an over-long
query that hits the trim path.
