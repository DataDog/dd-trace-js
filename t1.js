{
  "filter": {},
  "exp": {
    "lists": {},
    "maps": {},
    "bit": {},
    "hll": {},
    "type": {
      "NIL": 0,
      "INT": 2,
      "STR": 3,
      "LIST": 4,
      "MAP": 5,
      "BLOB": 6,
      "FLOAT": 7,
      "GEOJSON": 8,
      "HLL": 9,
      "AUTO": 10,
      "ERROR": 11
    },
    "operations": {}
  },
  "regex": {
    "BASIC": 0,
    "EXTENDED": 1,
    "ICASE": 2,
    "NEWLINE": 4
  },
  "info": {
    "separators": {
      "bins": [
        ";:",
        null
      ],
      "bins/*": [
        null
      ],
      "namespace/*": [
        ";="
      ],
      "service": [
        ";"
      ],
      "sindex": [
        ";",
        ":="
      ],
      "sindex/*": [
        ";",
        ":="
      ],
      "sindex/*/**": [
        ";="
      ],
      "udf-list": [
        ";",
        ",="
      ],
      "get-dc-config": [
        ";",
        ":="
      ],
      "sets": [
        ";",
        ":="
      ],
      "sets/*": [
        ";",
        ":="
      ],
      "sets/*/**": [
        null,
        ":="
      ]
    }
  },
  "admin": {},
  "lists": {
    "order": {
      "UNORDERED": 0,
      "ORDERED": 1
    },
    "sortFlags": {
      "DEFAULT": 0,
      "DROP_DUPLICATES": 2
    },
    "writeFlags": {
      "DEFAULT": 0,
      "ADD_UNIQUE": 1,
      "INSERT_BOUNDED": 2,
      "NO_FAIL": 4,
      "PARTIAL": 8
    },
    "returnType": {
      "NONE": 0,
      "INDEX": 1,
      "REVERSE_INDEX": 2,
      "RANK": 3,
      "REVERSE_RANK": 4,
      "COUNT": 5,
      "VALUE": 7,
      "EXISTS": 13,
      "INVERTED": 65536
    }
  },
  "hll": {
    "writeFlags": {
      "DEFAULT": 0,
      "CREATE_ONLY": 1,
      "UPDATE_ONLY": 2,
      "NO_FAIL": 4,
      "ALLOW_FOLD": 8
    }
  },
  "maps": {
    "order": {
      "UNORDERED": 0,
      "KEY_ORDERED": 1,
      "KEY_VALUE_ORDERED": 3
    },
    "writeMode": {
      "UPDATE": 0,
      "UPDATE_ONLY": 1,
      "CREATE_ONLY": 2
    },
    "writeFlags": {
      "DEFAULT": 0,
      "CREATE_ONLY": 1,
      "UPDATE_ONLY": 2,
      "NO_FAIL": 4,
      "PARTIAL": 8
    },
    "returnType": {
      "NONE": 0,
      "INDEX": 1,
      "REVERSE_INDEX": 2,
      "RANK": 3,
      "REVERSE_RANK": 4,
      "COUNT": 5,
      "KEY": 6,
      "VALUE": 7,
      "KEY_VALUE": 8,
      "EXISTS": 13,
      "UNORDERED_MAP": 16,
      "ORDERED_MAP": 17,
      "INVERTED": 65536
    },
    "opcodes": {
      "SET_TYPE": 64,
      "ADD": 65,
      "ADD_ITEMS": 66,
      "PUT": 67,
      "PUT_ITEMS": 68,
      "REPLACE": 69,
      "REPLACE_ITEMS": 70,
      "INCREMENT": 73,
      "DECREMENT": 74,
      "CLEAR": 75,
      "REMOVE_BY_KEY": 76,
      "REMOVE_BY_INDEX": 77,
      "REMOVE_BY_RANK": 79,
      "REMOVE_BY_KEY_LIST": 81,
      "REMOVE_ALL_BY_VALUE": 82,
      "REMOVE_BY_VALUE_LIST": 83,
      "REMOVE_BY_KEY_INTERVAL": 84,
      "REMOVE_BY_INDEX_RANGE": 85,
      "REMOVE_BY_VALUE_INTERVAL": 86,
      "REMOVE_BY_RANK_RANGE": 87,
      "REMOVE_BY_KEY_REL_INDEX_RANGE": 88,
      "REMOVE_BY_VALUE_REL_RANK_RANGE": 89,
      "SIZE": 96,
      "GET_BY_KEY": 97,
      "GET_BY_INDEX": 98,
      "GET_BY_RANK": 100,
      "GET_ALL_BY_VALUE": 102,
      "GET_BY_KEY_INTERVAL": 103,
      "GET_BY_INDEX_RANGE": 104,
      "GET_BY_VALUE_INTERVAL": 105,
      "GET_BY_RANK_RANGE": 106,
      "GET_BY_KEY_LIST": 107,
      "GET_BY_VALUE_LIST": 108,
      "GET_BY_KEY_REL_INDEX_RANGE": 109,
      "GET_BY_VALUE_REL_RANK_RANGE": 110
    }
  },
  "cdt": {},
  "bitwise": {
    "writeFlags": {
      "DEFAULT": 0,
      "CREATE_ONLY": 1,
      "UPDATE_ONLY": 2,
      "NO_FAIL": 4,
      "PARTIAL": 8
    },
    "resizeFlags": {
      "DEFAULT": 0,
      "FROM_FRONT": 1,
      "GROW_ONLY": 2,
      "SHRINK_ONLY": 4
    },
    "overflow": {
      "FAIL": 0,
      "SATURATE": 2,
      "WRAP": 4
    }
  },
  "operations": {},
  "policy": {
    "gen": {
      "IGNORE": 0,
      "EQ": 1,
      "GT": 2
    },
    "key": {
      "DIGEST": 0,
      "SEND": 1
    },
    "exists": {
      "IGNORE": 0,
      "CREATE": 1,
      "UPDATE": 2,
      "REPLACE": 3,
      "CREATE_OR_REPLACE": 4
    },
    "replica": {
      "MASTER": 0,
      "ANY": 1,
      "SEQUENCE": 2,
      "PREFER_RACK": 3
    },
    "readModeAP": {
      "ONE": 0,
      "ALL": 1
    },
    "readModeSC": {
      "SESSION": 0,
      "LINEARIZE": 1,
      "ALLOW_REPLICA": 2,
      "ALLOW_UNAVAILABLE": 3
    },
    "commitLevel": {
      "ALL": 0,
      "MASTER": 1
    }
  },
  "status": {
    "AEROSPIKE_ERR_ASYNC_QUEUE_FULL": -11,
    "ERR_ASYNC_QUEUE_FULL": -11,
    "AEROSPIKE_ERR_CONNECTION": -10,
    "ERR_CONNECTION": -10,
    "AEROSPIKE_ERR_INVALID_NODE": -8,
    "ERR_INVALID_NODE": -8,
    "AEROSPIKE_ERR_NO_MORE_CONNECTIONS": -7,
    "ERR_NO_MORE_CONNECTIONS": -7,
    "AEROSPIKE_ERR_ASYNC_CONNECTION": -6,
    "ERR_ASYNC_CONNECTION": -6,
    "AEROSPIKE_ERR_CLIENT_ABORT": -5,
    "ERR_CLIENT_ABORT": -5,
    "AEROSPIKE_ERR_INVALID_HOST": -4,
    "ERR_INVALID_HOST": -4,
    "AEROSPIKE_NO_MORE_RECORDS": -3,
    "NO_MORE_RECORDS": -3,
    "AEROSPIKE_ERR_PARAM": -2,
    "ERR_PARAM": -2,
    "AEROSPIKE_ERR_CLIENT": -1,
    "ERR_CLIENT": -1,
    "AEROSPIKE_OK": 0,
    "OK": 0,
    "AEROSPIKE_ERR_SERVER": 1,
    "ERR_SERVER": 1,
    "AEROSPIKE_ERR_RECORD_NOT_FOUND": 2,
    "ERR_RECORD_NOT_FOUND": 2,
    "AEROSPIKE_ERR_RECORD_GENERATION": 3,
    "ERR_RECORD_GENERATION": 3,
    "AEROSPIKE_ERR_REQUEST_INVALID": 4,
    "ERR_REQUEST_INVALID": 4,
    "AEROSPIKE_ERR_RECORD_EXISTS": 5,
    "ERR_RECORD_EXISTS": 5,
    "AEROSPIKE_ERR_BIN_EXISTS": 6,
    "ERR_BIN_EXISTS": 6,
    "AEROSPIKE_ERR_CLUSTER_CHANGE": 7,
    "ERR_CLUSTER_CHANGE": 7,
    "AEROSPIKE_ERR_SERVER_FULL": 8,
    "ERR_SERVER_FULL": 8,
    "AEROSPIKE_ERR_TIMEOUT": 9,
    "ERR_TIMEOUT": 9,
    "AEROSPIKE_ERR_ALWAYS_FORBIDDEN": 10,
    "ERR_ALWAYS_FORBIDDEN": 10,
    "AEROSPIKE_ERR_CLUSTER": 11,
    "ERR_CLUSTER": 11,
    "AEROSPIKE_ERR_BIN_INCOMPATIBLE_TYPE": 12,
    "ERR_BIN_INCOMPATIBLE_TYPE": 12,
    "AEROSPIKE_ERR_RECORD_TOO_BIG": 13,
    "ERR_RECORD_TOO_BIG": 13,
    "AEROSPIKE_ERR_RECORD_BUSY": 14,
    "ERR_RECORD_BUSY": 14,
    "AEROSPIKE_ERR_SCAN_ABORTED": 15,
    "ERR_SCAN_ABORTED": 15,
    "AEROSPIKE_ERR_UNSUPPORTED_FEATURE": 16,
    "ERR_UNSUPPORTED_FEATURE": 16,
    "AEROSPIKE_ERR_BIN_NOT_FOUND": 17,
    "ERR_BIN_NOT_FOUND": 17,
    "AEROSPIKE_ERR_DEVICE_OVERLOAD": 18,
    "ERR_DEVICE_OVERLOAD": 18,
    "AEROSPIKE_ERR_RECORD_KEY_MISMATCH": 19,
    "ERR_RECORD_KEY_MISMATCH": 19,
    "AEROSPIKE_ERR_NAMESPACE_NOT_FOUND": 20,
    "ERR_NAMESPACE_NOT_FOUND": 20,
    "AEROSPIKE_ERR_BIN_NAME": 21,
    "ERR_BIN_NAME": 21,
    "AEROSPIKE_ERR_FAIL_FORBIDDEN": 22,
    "ERR_FAIL_FORBIDDEN": 22,
    "AEROSPIKE_ERR_FAIL_ELEMENT_NOT_FOUND": 23,
    "ERR_FAIL_ELEMENT_NOT_FOUND": 23,
    "AEROSPIKE_ERR_FAIL_ELEMENT_EXISTS": 24,
    "ERR_FAIL_ELEMENT_EXISTS": 24,
    "AEROSPIKE_ERR_ENTERPRISE_ONLY": 25,
    "ERR_ENTERPRISE_ONLY": 25,
    "AEROSPIKE_ERR_FAIL_ENTERPRISE_ONLY": 25,
    "ERR_FAIL_ENTERPRISE_ONLY": 25,
    "AEROSPIKE_ERR_OP_NOT_APPLICABLE": 26,
    "ERR_OP_NOT_APPLICABLE": 26,
    "AEROSPIKE_FILTERED_OUT": 27,
    "FILTERED_OUT": 27,
    "AEROSPIKE_LOST_CONFLICT": 28,
    "LOST_CONFLICT": 28,
    "AEROSPIKE_QUERY_END": 50,
    "QUERY_END": 50,
    "AEROSPIKE_SECURITY_NOT_SUPPORTED": 51,
    "SECURITY_NOT_SUPPORTED": 51,
    "AEROSPIKE_SECURITY_NOT_ENABLED": 52,
    "SECURITY_NOT_ENABLED": 52,
    "AEROSPIKE_SECURITY_SCHEME_NOT_SUPPORTED": 53,
    "SECURITY_SCHEME_NOT_SUPPORTED": 53,
    "AEROSPIKE_INVALID_COMMAND": 54,
    "INVALID_COMMAND": 54,
    "AEROSPIKE_INVALID_FIELD": 55,
    "INVALID_FIELD": 55,
    "AEROSPIKE_ILLEGAL_STATE": 56,
    "ILLEGAL_STATE": 56,
    "AEROSPIKE_INVALID_USER": 60,
    "INVALID_USER": 60,
    "AEROSPIKE_USER_ALREADY_EXISTS": 61,
    "USER_ALREADY_EXISTS": 61,
    "AEROSPIKE_INVALID_PASSWORD": 62,
    "INVALID_PASSWORD": 62,
    "AEROSPIKE_EXPIRED_PASSWORD": 63,
    "EXPIRED_PASSWORD": 63,
    "AEROSPIKE_FORBIDDEN_PASSWORD": 64,
    "FORBIDDEN_PASSWORD": 64,
    "AEROSPIKE_INVALID_CREDENTIAL": 65,
    "INVALID_CREDENTIAL": 65,
    "AEROSPIKE_INVALID_ROLE": 70,
    "INVALID_ROLE": 70,
    "AEROSPIKE_ROLE_ALREADY_EXISTS": 71,
    "ROLE_ALREADY_EXISTS": 71,
    "AEROSPIKE_INVALID_PRIVILEGE": 72,
    "INVALID_PRIVILEGE": 72,
    "AEROSPIKE_INVALID_WHITELIST": 73,
    "INVALID_WHITELIST": 73,
    "AEROSPIKE_QUOTAS_NOT_ENABLED": 74,
    "QUOTAS_NOT_ENABLED": 74,
    "AEROSPIKE_INVALID_QUOTA": 75,
    "INVALID_QUOTA": 75,
    "AEROSPIKE_NOT_AUTHENTICATED": 80,
    "NOT_AUTHENTICATED": 80,
    "AEROSPIKE_ROLE_VIOLATION": 81,
    "ROLE_VIOLATION": 81,
    "AEROSPIKE_ERR_UDF": 100,
    "ERR_UDF": 100,
    "AEROSPIKE_ERR_BATCH_DISABLED": 150,
    "ERR_BATCH_DISABLED": 150,
    "AEROSPIKE_ERR_BATCH_MAX_REQUESTS_EXCEEDED": 151,
    "ERR_BATCH_MAX_REQUESTS_EXCEEDED": 151,
    "AEROSPIKE_ERR_BATCH_QUEUES_FULL": 152,
    "ERR_BATCH_QUEUES_FULL": 152,
    "AEROSPIKE_ERR_GEO_INVALID_GEOJSON": 160,
    "ERR_GEO_INVALID_GEOJSON": 160,
    "AEROSPIKE_ERR_INDEX_FOUND": 200,
    "ERR_INDEX_FOUND": 200,
    "AEROSPIKE_ERR_INDEX_NOT_FOUND": 201,
    "ERR_INDEX_NOT_FOUND": 201,
    "AEROSPIKE_ERR_INDEX_OOM": 202,
    "ERR_INDEX_OOM": 202,
    "AEROSPIKE_ERR_INDEX_NOT_READABLE": 203,
    "ERR_INDEX_NOT_READABLE": 203,
    "AEROSPIKE_ERR_INDEX": 204,
    "ERR_INDEX": 204,
    "AEROSPIKE_ERR_INDEX_NAME_MAXLEN": 205,
    "ERR_INDEX_NAME_MAXLEN": 205,
    "AEROSPIKE_ERR_INDEX_MAXCOUNT": 206,
    "ERR_INDEX_MAXCOUNT": 206,
    "AEROSPIKE_ERR_QUERY_ABORTED": 210,
    "ERR_QUERY_ABORTED": 210,
    "AEROSPIKE_ERR_QUERY_QUEUE_FULL": 211,
    "ERR_QUERY_QUEUE_FULL": 211,
    "AEROSPIKE_ERR_QUERY_TIMEOUT": 212,
    "ERR_QUERY_TIMEOUT": 212,
    "AEROSPIKE_ERR_QUERY": 213,
    "ERR_QUERY": 213,
    "AEROSPIKE_ERR_UDF_NOT_FOUND": 1301,
    "ERR_UDF_NOT_FOUND": 1301,
    "AEROSPIKE_ERR_LUA_FILE_NOT_FOUND": 1302,
    "ERR_LUA_FILE_NOT_FOUND": 1302
  },
  "features": {
    "CDT_MAP": "cdt-map",
    "CDT_LIST": "cdt-list",
    "BLOB_BITS": "blob-bits"
  },
  "auth": {
    "INTERNAL": 0,
    "EXTERNAL": 1,
    "EXTERNAL_INSECURE": 2,
    "AUTH_PKI": 3
  },
  "language": {
    "LUA": 0
  },
  "log": {
    "OFF": -1,
    "ERROR": 0,
    "WARN": 1,
    "INFO": 2,
    "DEBUG": 3,
    "TRACE": 4,
    "DETAIL": 4
  },
  "ttl": {
    "NAMESPACE_DEFAULT": 0,
    "NEVER_EXPIRE": -1,
    "DONT_UPDATE": -2
  },
  "jobStatus": {
    "UNDEF": 0,
    "INPROGRESS": 1,
    "COMPLETED": 2
  },
  "indexDataType": {
    "STRING": 0,
    "NUMERIC": 1,
    "GEO2DSPHERE": 2
  },
  "indexType": {
    "DEFAULT": 0,
    "LIST": 1,
    "MAPKEYS": 2,
    "MAPVALUES": 3
  },
  "batchType": {
    "BATCH_READ": 0,
    "BATCH_WRITE": 1,
    "BATCH_APPLY": 2,
    "BATCH_REMOVE": 3
  },
  "privilegeCode": {
    "USER_ADMIN": 0,
    "SYS_ADMIN": 1,
    "DATA_ADMIN": 2,
    "UDF_ADMIN": 3,
    "SINDEX_ADMIN": 4,
    "READ": 10,
    "READ_WRITE": 11,
    "READ_WRITE_UDF": 12,
    "WRITE": 13,
    "TRUNCATE": 14
  }
}