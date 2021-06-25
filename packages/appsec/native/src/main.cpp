#define NAPI_VERSION  3
#define MAX_DEPTH     20
#include <napi.h>
#include "PowerWAF.h"
#include "main.h"

Napi::Object Version(const Napi::CallbackInfo& info) {
  PWVersion       version   = pw_getVersion();
  Napi::Env       env       = info.Env();
  Napi::Object    result    = Napi::Object::New(env);

  result.Set(Napi::String::New(env, "major"), Napi::Number::New(env, version.major));
  result.Set(Napi::String::New(env, "minor"), Napi::Number::New(env, version.minor));
  result.Set(Napi::String::New(env, "patch"), Napi::Number::New(env, version.patch));

  return result;
}

Napi::Value WAFInit(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2) {
    Napi::TypeError::New(env, "Wrong number of arguments")
          .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!info[0].IsString() || !info[1].IsString()) {
    Napi::TypeError::New(env, "Wrong arguments, expected strings").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string id = info[0].ToString().Utf8Value();
  std::string rules = info[1].ToString().Utf8Value();

  int result = pw_init(id.c_str(), rules.c_str(), nullptr, nullptr);
  if (result != 1) {
    // TODO(vdeturckheim): use feedback from the pw_init errors
    Napi::Error::New(env, "Error loading rules")
          .ThrowAsJavaScriptException();
  }
  return env.Null();
}

Napi::Value Clear(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Wrong number of arguments")
          .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!info[0].IsString()) {
    Napi::TypeError::New(env, "Wrong argument, expected string").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string id = info[0].ToString().Utf8Value();
  pw_clearRule(id.c_str());
  return env.Null();
}

Napi::Value ClearAll(const Napi::CallbackInfo& info) {
  pw_clearAll();
  return info.Env().Null();
}

PWArgs ToPWArgs(Napi::Value val, int depth);

PWArgs FromArray(Napi::Array arr, int depth) {
  uint32_t  len     = arr.Length(); // FIXME(vdeturckheim): there might be an error here (Env::IsExceptionPending)
  PWArgs    result  = pw_createArray();
  for (uint32_t i = 0; i < len; ++i) {
    Napi::Value item  = arr.Get(i);
    PWArgs      val   = ToPWArgs(item, depth);
    if(!pw_addArray(&result, val)) {
      pw_freeArg(&val);
    }
  }
  return result;
}

PWArgs FromObject(Napi::Object obj, int depth) {
  PWArgs      result      = pw_createMap();
  Napi::Array properties  = obj.GetPropertyNames();
  uint32_t    len         = properties.Length(); // FIXME(vdeturckheim): check Env::IsExceptionPending
  for (uint32_t i = 0; i < len; ++i) {
    Napi::Value keyV  = properties.Get(i);
    if (!obj.HasOwnProperty(keyV) || !keyV.IsString()) {
      // We avoid inherited properties here. If the key is not a String, well this is weird
      continue;
    }
    std::string key   = keyV.ToString().Utf8Value();
    Napi::Value valV  = obj.Get(keyV);
    PWArgs      val   = ToPWArgs(valV, depth);
    if(!pw_addMap(&result, key.c_str(), key.length(), val)) {
      pw_freeArg(&val);
    }
  }
  return result;
}

PWArgs ToPWArgs(Napi::Value val, int depth) {
  if (depth >= MAX_DEPTH) {
    return pw_getInvalid();
  }
  if (val.IsString()) {
    return pw_createString(val.ToString().Utf8Value().c_str());
  }
  if (val.IsNumber()) {
    return pw_createInt(val.ToNumber().Int64Value());
  }
  if (val.IsArray()) {
    return FromArray(val.ToObject().As<Napi::Array>(), depth + 1);
  }
  if (val.IsObject()) {
    return FromObject(val.ToObject(), depth + 1);
  }

  // TODO(vdeturckheim): booleans and nulls?

  return pw_getInvalid();
}

Napi::Value handleResult(Napi::Env env, PWRet ret) {
  switch(ret.action) {
    case PW_ERR_INTERNAL:
      Napi::Error::New(env, "Internal error").ThrowAsJavaScriptException();
      return env.Null();
    case PW_ERR_INVALID_CALL:
      Napi::Error::New(env, "Invalid call").ThrowAsJavaScriptException();
      return env.Null();
    case PW_ERR_TIMEOUT:
      Napi::Error::New(env, "TIMEOUT").ThrowAsJavaScriptException();
      return env.Null();
    case PW_ERR_INVALID_RULE:
      Napi::Error::New(env, "Invalid rule").ThrowAsJavaScriptException();
      return env.Null();
    case PW_ERR_INVALID_FLOW:
      Napi::Error::New(env, "Invalid flow").ThrowAsJavaScriptException();
      return env.Null();
    case PW_ERR_NORULE:
      Napi::Error::New(env, "No rule provided").ThrowAsJavaScriptException();
      return env.Null();
    default:
      break;
  }
  Napi::Object result = Napi::Object::New(env);
  if (ret.action == PW_BLOCK) {
    result.Set(Napi::String::New(env, "status"), Napi::String::New(env, "raise"));
  }
  if ((ret.action == PW_BLOCK || ret.action == PW_MONITOR) && ret.data != nullptr) {
    result.Set(Napi::String::New(env, "record"), Napi::String::New(env, ret.data));
  }
  if (ret.perfTotalRuntime != 0) {
    result.Set(Napi::String::New(env, "perfTotalRuntime"), Napi::Number::New(env, ret.perfTotalRuntime));
  }
  if(ret.perfCacheHitRate != 0) {
    result.Set(Napi::String::New(env, "perfCacheHitRate"), Napi::Number::New(env, ret.perfCacheHitRate));
  }
  if (ret.perfData != nullptr) {
    result.Set(Napi::String::New(env, "perfData"), Napi::String::New(env, ret.perfData));
  }
  return result;
}

Napi::Value Run(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Wrong number of arguments")
          .ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!info[0].IsString()) {
    Napi::TypeError::New(env, "Wrong argument, expected id as string").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (!info[1].IsObject()) {
    Napi::TypeError::New(env, "Wrong argument, expected inputs as object").ThrowAsJavaScriptException();
    return env.Null();
  }
  // when we drop support for node <= 12, this will have to be a BigInt
  // TODO(vdeturckheim): check NaN behaviour's here
  if (!info[2].IsNumber()) {
    Napi::TypeError::New(env, "Wrong argument, expected budget as number").ThrowAsJavaScriptException();
    return env.Null();
  }

  std::string   id        = info[0].ToString().Utf8Value();
  Napi::Object  rawInputs = info[1].ToObject();
  uint64_t      budget    = static_cast<size_t>(info[2].ToNumber().DoubleValue());
  PWArgs        inputs    = ToPWArgs(rawInputs, 0);

  PWRet         ret       = pw_run(id.c_str(), inputs, budget);

  Napi::Value   result    = handleResult(env, ret);

  pw_freeArg(&inputs);
  pw_freeReturn(ret);

  return result;
}


Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set(Napi::String::New(env, "init"), Napi::Function::New(env, WAFInit));
  exports.Set(Napi::String::New(env, "run"), Napi::Function::New(env, Run));
  exports.Set(Napi::String::New(env, "version"), Napi::Function::New(env, Version));
  exports.Set(Napi::String::New(env, "clear"), Napi::Function::New(env, Clear));
  exports.Set(Napi::String::New(env, "clearAll"), Napi::Function::New(env, ClearAll));
  return exports;
}

NODE_API_MODULE(hello, Init)
