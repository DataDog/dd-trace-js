#!/usr/bin/env python3
import sys
import json
import os
import openai
from dd_internal_authentication.client import JWTInternalServiceAuthClientTokenManager, JWTDDToolAuthClientTokenManager

# Configuration - these should be environment variables or config
ORG_ID = os.getenv("DD_ORG_ID", "2")
SOURCE = "dd-apm-analyze"

def get_client():
    local = os.getenv("DD_AI_GATEWAY_LOCAL", "true").lower() == "true"
    
    if local:
        token = JWTDDToolAuthClientTokenManager.instance(
            name="rapid-ai-platform", 
            datacenter='us1.staging.dog'
        ).get_token("rapid-ai-platform")
        host = "https://ai-gateway.us1.staging.dog"
    else:
        token = JWTInternalServiceAuthClientTokenManager.instance(
            name="rapid-ai-platform"
        ).get_token("rapid-ai-platform")
        host = "http://ai-gateway.rapid-ai-platform.sidecar-proxy.fabric.dog:15001"
    
    return openai.OpenAI(
        api_key=token,
        base_url=f"{host}/v1",
        default_headers={
            "source": SOURCE,
            "org-id": ORG_ID,
        },
    )

def call_llm(messages, model="openai/gpt-4o-mini", max_tokens=2000, temperature=0.1):
    try:
        client = get_client()
        response = client.chat.completions.create(
            model=model,
            stream=False,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            extra_body={"tags": {"tool": "dd-apm-analyze", "function": "assistant"}}
        )
        return {
            "success": True,
            "content": response.choices[0].message.content
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

if __name__ == "__main__":
    try:
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())
        messages = input_data.get("messages", [])
        model = input_data.get("model", "openai/gpt-4o-mini")
        max_tokens = input_data.get("max_tokens", 2000)
        temperature = input_data.get("temperature", 0.1)
        
        result = call_llm(messages, model, max_tokens, temperature)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"success": False, "error": f"Bridge error: {str(e)}"}))
