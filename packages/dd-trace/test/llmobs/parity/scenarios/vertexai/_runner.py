import os
from urllib.parse import urlparse

import requests
import vertexai
from google.auth.credentials import AnonymousCredentials

from common import finish, start


def run(scenario):
    start("vertexai")
    provider = os.environ["PROVIDER_BASE_URL"]
    host = urlparse(provider).netloc
    original_request = requests.sessions.Session.request

    def request(self, method, url, **kwargs):
        return original_request(self, method, url.replace(f"https://{host}", provider), **kwargs)

    requests.sessions.Session.request = request
    try:
        vertexai.init(
            project="parity-project",
            location="us-central1",
            api_endpoint=host,
            api_transport="rest",
            credentials=AnonymousCredentials(),
        )
        from vertexai.generative_models import GenerativeModel
        from vertexai.generative_models import Content, Part
        from vertexai.generative_models import _generative_models as generative_models

        model = GenerativeModel(
            "gemini-1.5-flash",
            system_instruction="You are a parity bot.",
            generation_config={"temperature": 1, "max_output_tokens": 50},
        )
        if scenario == "generate-content-stream":
            response = model.generate_content("Hello, how are you?", stream=True)
            for _ in response:
                pass
        elif scenario == "chat-send-message":
            chat = model.start_chat(history=[
                Content(role="user", parts=[Part.from_text("Hello.")]),
                Content(role="model", parts=[Part.from_text("Hi.")]),
            ])
            chat.send_message("Continue the parity conversation.")
        elif scenario == "generate-content-tools":
            contents = [
                Content(role="user", parts=[Part.from_text("What is 2 + 2?")]),
                Content(role="model", parts=[generative_models.Part._from_gapic(generative_models.gapic_content_types.Part(function_call=generative_models.gapic_tool_types.FunctionCall(name="add", args={"a": 2, "b": 2})))]),
                Content(
                    role="user",
                    parts=[Part.from_function_response(name="add", response={"result": 4})],
                ),
            ]
            model.generate_content(contents)
        else:
            model.generate_content("Hello, how are you?")
    except Exception:
        pass
    finally:
        requests.sessions.Session.request = original_request
        finish()
