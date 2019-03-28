{
  "targets": [{
    "target_name": "metrics",
    "sources": [
      "src/native/metrics/Collector.cpp",
      "src/native/metrics/EventLoop.cpp",
      "src/native/metrics/GarbageCollection.cpp",
      "src/native/metrics/Heap.cpp",
      "src/native/metrics/Histogram.cpp",
      "src/native/metrics/Object.cpp",
      "src/native/metrics/Process.cpp",
      "src/native/metrics/SpanTracker.cpp",
      "src/native/metrics/utils.cpp",
      "src/native/metrics/main.cpp"
    ],
    "include_dirs": [
      "src",
      "<!(node -e \"require('nan')\")"
    ],
    "xcode_settings": {
      "MACOSX_DEPLOYMENT_TARGET": "10.7",
      "OTHER_CFLAGS": [
        "-std=c++11",
        "-stdlib=libc++",
        "-Wall",
        "-Werror"
      ]
    }
  }]
}
