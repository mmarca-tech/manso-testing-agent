# LLM And Observability

## Provider Selection

`LLM_PROVIDER` selects the default provider:

| Provider | Default runner |
| --- | --- |
| `openai` | OpenAI client and Codex SDK runner for implementation. |
| `anthropic` | Anthropic client and Claude Agent SDK runner for implementation. |

The public workflows use LLM calls for bounded tasks:

- Xray test planning.
- Existing Xray coverage review.
- Pull request change summary.
- Confluence impact summary.
- Release-note generation.
- Pull request code and business review.
- Implementation and verification healing.

## Prompt Boundaries

LLM tasks should:

- Use only retrieved Jira, Confluence, Xray, PR, repository, and memory evidence.
- Preserve uncertainty explicitly.
- Keep English output.
- Produce structured JSON through validated schemas when the workflow expects machine-readable output.
- Avoid broad product assumptions not supported by evidence.

## Implementation Runners

`implement-xray-tests` chooses the implementation runner from provider configuration unless an explicit shell command is supplied.

| Configuration | Behavior |
| --- | --- |
| `LLM_PROVIDER=openai` | Uses `@openai/codex-sdk`. |
| `LLM_PROVIDER=anthropic` | Uses `@anthropic-ai/claude-agent-sdk`. |
| `--agent-command` | Uses the supplied shell command and passes the prompt on stdin. |
| `--agent-path` | Overrides the provider executable path. |
| `--agent-arguments` | Supplies arguments for an explicit agent command. |

All runners receive `MANSO_TEST_IMPLEMENTATION_PROMPT`, `MANSO_TEST_ISSUE`, `MANSO_TEST_BRANCH`, and `MANSO_TEST_TARGET_BRANCH`.

## Verification Healing

When a verification command fails, the implementation workflow can run a healing loop. The failed command output is passed back to the implementation runner. The default maximum is four attempts.

Control healing with:

| Option | Purpose |
| --- | --- |
| `--heal-attempts <number>` | Set retry count. |
| `--heal-agent-command <command>` | Use a separate repair command. |
| `--no-heal` | Disable healing. |

Pull request creation remains gated on a passing verification command.

## OpenTelemetry

Tracing is opt-in:

```env
OTEL_PROVIDER=phoenix
OTEL_ENABLED=true
OTEL_PROJECT_NAME=manso-testing-agent
OTEL_ENDPOINT=http://localhost:6006
```

Supported providers:

| Provider | Typical endpoint |
| --- | --- |
| Phoenix local | `http://localhost:6006` |
| Langfuse local | `http://localhost:3000` |
| Langfuse cloud | `https://cloud.langfuse.com` or region-specific host |

Workflow spans include parent spans such as:

- `workflow.generate-xray-tests`
- `workflow.implement-xray-tests`
- `workflow.generate-release-notes`
- `workflow.review-pull-request`

Nested spans track extraction, planning, implementation, review, and model-backed tasks.

## Trace Privacy

OpenInference may store prompt and response content. Use:

```env
OPENINFERENCE_HIDE_INPUTS=true
OPENINFERENCE_HIDE_OUTPUTS=true
```

Token, model, workflow, and cost metadata can still be recorded without storing prompt or response text.

