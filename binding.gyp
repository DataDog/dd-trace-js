{
  "targets": [{
    "target_name": "metrics",
    "sources": [
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
      "MACOSX_DEPLOYMENT_TARGET": "10.10",
      "OTHER_CFLAGS": [
        "-std=c++14",
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
        ],
        "cflags_cc": [
          "-Wno-cast-function-type"
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
