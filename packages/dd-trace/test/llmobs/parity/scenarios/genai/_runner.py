import os

from google import genai
from google.genai import types

from common import finish, start


def run(scenario):
    start("google_genai")
    client = genai.Client(api_key="test", http_options={"base_url": os.environ["PROVIDER_BASE_URL"]})
    model = "models/gemini-2.5-flash" if scenario == "generate-content-model-path" else "gemini-2.5-flash"
    try:
        if scenario == "embed-content":
            client.models.embed_content(
                model="text-embedding-004",
                contents="Hello, world!",
                config=types.EmbedContentConfig(task_type="RETRIEVAL_QUERY", output_dimensionality=8),
            )
        elif scenario == "generate-content-stream":
            for _ in client.models.generate_content_stream(
                model=model,
                contents="Hello, world!",
                config=types.GenerateContentConfig(
                    temperature=0.5,
                    max_output_tokens=100,
                    system_instruction="You are a parity bot.",
                ),
            ):
                pass
        else:
            contents = "Hello, world!"
            config = types.GenerateContentConfig(
                temperature=0.5,
                max_output_tokens=100,
                system_instruction="You are a parity bot.",
            )
            if scenario == "generate-content-tools":
                contents = [
                    types.Content(role="user", parts=[types.Part.from_text(text="Use the tool.")]),
                    types.Content(
                        role="model",
                        parts=[types.Part(function_call=types.FunctionCall(name="lookup", args={"value": "parity"}, id="call-1"))],
                    ),
                    types.Content(
                        role="user",
                        parts=[types.Part(function_response=types.FunctionResponse(name="lookup", response={"value": "ok"}, id="call-1"))],
                    ),
                ]
                config.tools = [types.Tool(function_declarations=[types.FunctionDeclaration(
                    name="lookup",
                    description="Look up a value.",
                    parameters={"type": "OBJECT", "properties": {"value": {"type": "STRING"}}},
                )])]
            client.models.generate_content(model=model, contents=contents, config=config)
    except Exception:
        pass
    finally:
        finish()
