# Configuration Reference

## Jira And Confluence

| Variable | Required for | Purpose |
| --- | --- | --- |
| `JIRA_URL` | Jira-backed workflows | Jira base URL. |
| `JIRA_USERNAME` | Jira-backed workflows | Jira service account username. |
| `JIRA_API_TOKEN` | Jira-backed workflows | Jira API token. |
| `JIRA_CLOUD_ID` | Optional | Jira Cloud id for Atlassian GraphQL development information. |
| `CONFLUENCE_ENABLED` | Optional | Set `false` to skip Confluence page hydration. Defaults to true. |
| `CONFLUENCE_URL` | Confluence hydration | Confluence base URL. Defaults to `JIRA_URL` plus `/wiki`. |
| `CONFLUENCE_USERNAME` | Confluence hydration | Confluence username. Defaults to Jira username. |
| `CONFLUENCE_API_TOKEN` | Confluence hydration | Confluence API token. Defaults to Jira token. |

## Azure DevOps

| Variable | Required for | Purpose |
| --- | --- | --- |
| `AZURE_DEVOPS_PAT` | PR summaries, PR reviews, implementation PRs, memory PRs | Azure DevOps API token. |
| `AZURE_DEVOPS_TOKEN` | Optional fallback | Alternative Azure DevOps token variable. |
| `SYSTEM_ACCESSTOKEN` | Azure DevOps pipeline fallback | Pipeline OAuth token when scripts can access it. |

## LLM Provider

| Variable | Required for | Purpose |
| --- | --- | --- |
| `LLM_PROVIDER` | LLM-backed workflows | `openai` or `anthropic`. Defaults to OpenAI behavior. |
| `LLM_API_KEY` | LLM-backed workflows | Generic provider API key. |
| `LLM_MODEL` | LLM-backed workflows | Generic provider model. |
| `LLM_BASE_URL` | Optional | Generic provider base URL override. |
| `OPENAI_API_KEY` | OpenAI fallback | Provider-specific OpenAI key. |
| `OPENAI_MODEL` | OpenAI fallback | Provider-specific OpenAI model. |
| `OPENAI_BASE_URL` | Optional | OpenAI base URL override. |
| `ANTHROPIC_API_KEY` | Anthropic fallback | Provider-specific Anthropic key. |
| `ANTHROPIC_MODEL` | Anthropic fallback | Provider-specific Anthropic model. |
| `ANTHROPIC_API_VERSION` | Optional | Anthropic API version. |
| `ANTHROPIC_MAX_OUTPUT_TOKENS` | Optional | Anthropic max output tokens. |

## Implementation Agent

| Variable | Purpose |
| --- | --- |
| `MANSO_TEST_IMPLEMENTATION_AGENT_PATH` | Provider executable override. |
| `MANSO_TEST_IMPLEMENTATION_AGENT_ARGUMENTS` | Arguments for an explicit agent command. |
| `MANSO_TEST_IMPLEMENTATION_COMMAND` | Explicit shell command implementation runner. |
| `MANSO_TEST_VERIFY_COMMAND` | Default verification command override. |
| `MANSO_TEST_IMPLEMENTATION_PROMPT` | Prompt passed to implementation runners. Set by the workflow. |
| `MANSO_TEST_ISSUE` | Issue key passed to implementation runners. Set by the workflow. |
| `MANSO_TEST_BRANCH` | Implementation branch passed to runners. Set by the workflow. |
| `MANSO_TEST_TARGET_BRANCH` | Target branch passed to runners. Set by the workflow. |

## Memory Cabin

| Variable | Purpose |
| --- | --- |
| `MANSO_MEMORY_ROOT` | Filesystem path or Git URL for durable memory. |
| `MANSO_MEMORY_ENABLED` | Set `false` to disable memory. Defaults to enabled when root is set. |
| `MANSO_MEMORY_CACHE_DIR` | Local clone cache. Defaults to `~/.manso/memory-cabins`. |
| `MANSO_MEMORY_BRANCH` | Branch to clone or checkout when root is a Git URL. |
| `MANSO_MEMORY_STRICT` | Set `true` to fail workflows when memory mirroring fails. |
| `MANSO_CODEX_FORWARD_OTEL` | Forward selected telemetry backend into Codex SDK config. |
| `MANSO_CODEX_SDK_CONFIG` | Explicit Codex SDK config JSON. |

## OpenTelemetry

| Variable | Purpose |
| --- | --- |
| `OTEL_PROVIDER` | `phoenix` or `langfuse`. |
| `OTEL_ENABLED` | Enables tracing when true. |
| `OTEL_PROJECT_NAME` | Project name in telemetry backend. |
| `OTEL_ENDPOINT` | Backend endpoint. |
| `OTEL_API_KEY` | Phoenix bearer token when required. |
| `OTEL_PUBLIC_KEY` | Langfuse public key. |
| `OTEL_SECRET_KEY` | Langfuse secret key. |
| `OTEL_SESSION_ID` | Optional shared session id. |
| `OTEL_USER_ID` | Optional user id fallback. |
| `OTEL_BATCH` | Batch exporter behavior. |
| `OPENINFERENCE_HIDE_INPUTS` | Hide prompt content in traces. |
| `OPENINFERENCE_HIDE_OUTPUTS` | Hide response content in traces. |

## Xray Cloud

| Variable | Required for | Purpose |
| --- | --- | --- |
| `XRAY_BASE_URL` | Xray workflows | Xray Cloud base URL. |
| `XRAY_CLIENT_ID` | Xray workflows | Xray Cloud client id. |
| `XRAY_CLIENT_SECRET` | Xray workflows | Xray Cloud client secret. |
| `XRAY_TEST_LINK_TYPE` | Optional | Jira issue link type lookup hint. Defaults to `tests`. |
| `XRAY_TEST_LINK_DIRECTION` | Optional | `test-to-ticket` or `ticket-to-test`. |

