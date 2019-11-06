{
  "targets": [{
    "target_name": "metrics",
    "sources": [
      "packages/dd-trace/src/native/hdr_histogram/hdr_encoding.c",
      "packages/dd-trace/src/native/hdr_histogram/hdr_histogram_log.c",
      "packages/dd-trace/src/native/hdr_histogram/hdr_histogram.c",
      "packages/dd-trace/src/native/hdr_histogram/hdr_interval_recorder.c",
      "packages/dd-trace/src/native/hdr_histogram/hdr_thread.c",
      "packages/dd-trace/src/native/hdr_histogram/hdr_time.c",
      "packages/dd-trace/src/native/hdr_histogram/hdr_writer_reader_phaser.c",
      "packages/dd-trace/src/native/metrics/Collector.cpp",
      "packages/dd-trace/src/native/metrics/EventLoop.cpp",
      "packages/dd-trace/src/native/metrics/GarbageCollection.cpp",
      "packages/dd-trace/src/native/metrics/Heap.cpp",
      "packages/dd-trace/src/native/metrics/Histogram.cpp",
      "packages/dd-trace/src/native/metrics/Object.cpp",
      "packages/dd-trace/src/native/metrics/Process.cpp",
      "packages/dd-trace/src/native/metrics/SpanTracker.cpp",
      "packages/dd-trace/src/native/metrics/utils.cpp",
      "packages/dd-trace/src/native/metrics/main.cpp"
    ],
    "include_dirs": [
      "packages/dd-trace/src/native",
      "<!(node -e \"require('nan')\")"
    ],
    "xcode_settings": {
      "MACOSX_DEPLOYMENT_TARGET": "10.9",
      "CMAKE_CXX_STANDARD": "11",
      "OTHER_CFLAGS": [
        # "-std=c++11",
        "-stdlib=libc++",
        "-Wall",
        "-Werror"
      ]
    },
    "conditions": [
      ["OS == 'linux'", {
        "cflags": [
          "-std=c++11",
          "-Wall",
          "-Werror"
        ]
      }],
      ["OS == 'win'", {
        "cflags": [
          "/WX"
        ]
      }]
    ]
  }]
}
