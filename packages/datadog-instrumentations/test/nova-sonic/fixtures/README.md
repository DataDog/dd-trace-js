# Nova 2 Sonic protocol replays

Copied without modification from DataDog/dd-trace-py commit
`f425f62a2f5af99b56123a4a53d7daeb282adefb`,
`tests/contrib/aws_sdk_bedrock_runtime/fixtures/voice-session-{1,2}.json.gz`.

These sanitized live protocol captures have synthetic transcripts, remapped identifiers,
relative timestamps, and audio byte counts. Tests reconstruct silence with the same sample counts.
They cover five and six responses under a session-wide completion ID, multiple input windows,
queued output content, interruptions, late FINAL text, and cumulative modality usage.

These are protocol fixtures, not HTTP recordings or proof of device playback. SDK tests separately
exercise both iterables, cleanup, context isolation, and serialization using a canned transport.
