# Local runner for the LLM Validation CLI — no host .NET SDK required.
# The platform source is mounted at runtime (private repo; not baked in).
#
#   docker build -t llmval-dd-apm-sdk-review -f .llm-validation/docker/Dockerfile .llm-validation/docker
#   .llm-validation/docker/run.sh --level minimum --fake

FROM node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d

ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_ROLL_FORWARD=Major \
    NUGET_XMLDOC_MODE=skip \
    DOTNET_ROOT=/usr/share/dotnet \
    PATH="/usr/share/dotnet:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl jq ca-certificates \
    && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh --channel 10.0 --install-dir "$DOTNET_ROOT" \
    && ln -s "$DOTNET_ROOT/dotnet" /usr/local/bin/dotnet \
    && npm i -g @anthropic-ai/claude-code \
    && rm /tmp/dotnet-install.sh \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/llmval
RUN chmod +x /usr/local/bin/llmval

WORKDIR /platform
VOLUME ["/platform", "/repo"]

ENTRYPOINT ["llmval"]
CMD ["--repo", "/repo", "--base-sha", "master", "--level", "minimum"]
