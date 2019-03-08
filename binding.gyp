{
  "targets": [{
    "target_name": "metrics",
    "sources": [
      "src/native/metrics/HistogramAdapter.cpp",
      "src/native/metrics/Histogram.cpp",
      "src/native/metrics/EventLoop.cpp",
      "src/native/metrics/main.cpp"
    ],
    "include_dirs": [
      "src",
      "<!(node -e \"require('nan')\")"
    ]
  }]
}
