{
  "targets": [{
    "target_name": "metrics",
    "sources": [
      "packages/dd-trace/src/native/metrics/main.cc"
    ],
    "include_dirs": [
      "packages/dd-trace/src/native",
      "<!@(node -p \"require('node-addon-api').include\")",
    ],
    'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ],
    "xcode_settings": {
      "MACOSX_DEPLOYMENT_TARGET": "10.9",
      "OTHER_CFLAGS": [
        "-std=c++11",
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
      }],
      ['OS=="mac"', {
          'cflags+': ['-fvisibility=hidden'],
          'xcode_settings': {
            'GCC_SYMBOLS_PRIVATE_EXTERN': 'YES', # -fvisibility=hidden
          }
      }],
    ]
  }]
}
