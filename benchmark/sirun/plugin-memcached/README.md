# plugin-memcached

Measures the memcached plugin `bindStart`: resolve the server address (pinned
directly, or via the client HashRing for a key) and assemble the meta bag.
Variants cover a single-server get and the multi-server HashRing resolution.
