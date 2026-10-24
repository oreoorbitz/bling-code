# Ling Code

Ling Code is a full fork of [Pi](https://github.com/earendil-works/pi), focused on Ling 3.1 Flash while retaining Pi's CLI, TUI, tools, extensions, sessions, and automatic compaction. It is a clean-room harness configuration, not a copy of InclusionAI's closed LingCode implementation and not a reimplementation of model weights.

## Model policy

- **Ling 3.1 Flash is the default profile.** Its default served model ID is `Ling-3.1-flash`.
- **Ling 3.0 Flash is explicitly selectable** with `--profile 3.0`; it is never substituted silently for 3.1. Configuration rejects a recognizable 3.0/3.1 model ID paired with the opposite profile.
- **No hosted endpoint is implied.** `ling configure` requires `--base-url`.
- Credentials are referenced through an environment variable. The API key itself is not written to `models.json`.
- Both profiles default to a **262,144-token served context** and **32,768 output tokens**. Ling 3.1's 1M architectural context is not assumed to be available from an endpoint. Override these values only when the serving configuration actually supports them.

The 3.1 and 3.0 profiles use their respective vendor-recommended sampling values:

| Profile | Temperature | Top P | Top K |
| --- | ---: | ---: | ---: |
| Ling 3.1 Flash | 1.0 | 0.95 | 20 |
| Ling 3.0 Flash | 0.6 | 0.95 | 20 |

Model references: [Ling 3.1 Flash](https://huggingface.co/inclusionAI/Ling-3.1-flash), [Ling 3.0 Flash](https://huggingface.co/inclusionAI/Ling-3.0-flash), [Ling cookbook](https://github.com/inclusionAI/ling-cookbook), and [Ling 2.5 architecture](https://github.com/inclusionAI/Ling-V2.5).

## Configure an endpoint

Ling Code requires Node.js 22.19 or newer. From this source checkout:

```bash
npm install --ignore-scripts
npm run build
```

Configure a local vLLM or SGLang server with the Ling chat-template reasoning controls:

```bash
export LING_API_KEY=local-development-key
node packages/coding-agent/dist/bundle/cli.js configure \
  --base-url http://localhost:30000/v1 \
  --dialect chat-template
node packages/coding-agent/dist/bundle/cli.js
```

The environment variable above is an example placeholder for a local server, not a credential stored by Ling Code. If the local server has no authentication, configure its expected dummy value in the environment; do not put a real secret on the command line.

For a first-party Ant Ling-compatible endpoint, select the `ling` dialect and state the endpoint explicitly:

```bash
export LING_API_KEY='your-key-from-the-provider'
node packages/coding-agent/dist/bundle/cli.js configure \
  --base-url https://api.ant-ling.com/v1 \
  --dialect ling
```

For OpenRouter, use its served model ID and dialect:

```bash
export LING_API_KEY='your-key-from-the-provider'
node packages/coding-agent/dist/bundle/cli.js configure \
  --base-url https://openrouter.ai/api/v1 \
  --model-id inclusionai/ling-3.1-flash \
  --dialect openrouter
```

To select Ling 3.0 instead, run a separate explicit configuration:

```bash
node packages/coding-agent/dist/bundle/cli.js configure \
  --base-url http://localhost:30000/v1 \
  --profile 3.0 \
  --model-id inclusionAI/Ling-3.0-flash \
  --dialect chat-template \
  --force
```

`--force` is required to replace an existing `ling` provider entry. Configuration writes `~/.ling/agent/models.json` atomically and selects the exact `ling/<model-id>` default in `settings.json`. Other providers in `models.json` are preserved. Output tokens cannot exceed the configured context window.

Run `ling doctor` after setup. It checks the endpoint, reasoning dialect, model limits, credential reference, and exact saved default without making an API request or displaying credential values. A saved default for another provider is a warning rather than an error; explicit non-Ling selection remains supported.

### Dialects

| Dialect | Intended endpoint | Reasoning request field |
| --- | --- | --- |
| `chat-template` | vLLM/SGLang with Ling 3 parsers | `chat_template_kwargs.enable_thinking` and `preserve_thinking` |
| `ling` | First-party Ant Ling OpenAI-compatible API | `thinking.type: enabled/disabled` |
| `openrouter` | OpenRouter | OpenRouter reasoning controls |

For local serving, enable the Ling reasoning and tool-call parsers. With vLLM, the model cards recommend `--reasoning-parser ling3 --tool-call-parser ling3 --enable-auto-tool-choice`. The endpoint must return standard OpenAI streaming responses; reasoning may be in `reasoning_content`, `reasoning`, or `reasoning_text`.

The default request compatibility also uses `max_tokens`, disables the OpenAI `store` field, and sends system rather than developer messages. Edit `models.json` if a particular endpoint has different limits or compatibility behavior. See `packages/coding-agent/docs/models.md` for all configuration fields.

## Long-running coding sessions

Pi's existing behavior is retained:

- Automatic context compaction remains enabled, with 16,384 reserved tokens and 20,000 recent tokens kept by default.
- Use `ling --continue` to continue the latest project session or `ling --resume` to select a session.
- The system prompt asks the model to track remaining work, run checks, distinguish executed work from proposals, and inspect final changes.
- A missing or unauthenticated `ling` default does not fall through to another authenticated provider. Resuming a Ling session follows the same rule even if the saved default now names another provider. Select another model explicitly with `--provider` and `--model` if desired.
- Blank or thinking-only summarization responses are rejected rather than saved as empty compaction checkpoints.

Endpoint-specific context and output limits still control when compaction occurs. Do not set a 1M context merely because the model architecture supports it.

## Project-local learning

Ling Code keeps learning state separate for each project under `.ling/learning/`:

- `actions.jsonl` is an append-only ledger of finalized messages, tool executions, and benchmark runs, including provider-returned reasoning. Deterministic `act_`, `tool_`, and `run_` IDs make replay idempotent. Tool records include `parentActionId` when the requesting assistant message was logged, linking execution evidence back to that model action.
- `memory.json` is bounded curated project memory, with a generated `MEMORY.md` view. Its default total budget is 6,000 characters; overflow fails rather than silently evicting older facts. Hand-edited duplicate, unsafe, credential-shaped, or over-budget state is rejected by normal consumers; review-only loading can still compact oversized memory. Curated memory enters the system prompt only for trusted projects.
- `reviews.jsonl` retains generative review responses and reasoning, typed Decider results, and provider-returned failures. `proposals.json` tracks pending, rejected, and applied improvements. `cursor.json` records the last processed action ID.
- The directory's `.gitignore` excludes learning state from version control. Credential-shaped fields and common credential patterns are redacted, but redaction is best-effort; do not paste secrets into prompts, tools, or memory.

The complete action history is retained and can grow. Review prompts are bounded independently: the defaults are 80 actions and 180,000 estimated input tokens per batch. The budget covers actions, project memory, and skill snapshots together; oversized snapshots are compacted or omitted with explicit counts. This lets a review use Ling's long context without sending the entire project ledger.

### Review and approve improvements

Run a review interactively with `/improve`, or from the shell:

```bash
ling improve
ling learning list
ling learning show <proposal-id>
ling learning approve <proposal-id>
```

Interactive equivalents are `/learning pending`, `/learning show`, `/learning approve`, and `/learning reject`. Use `/learning status`, `/learning actions [query]`, and `/learning memory` to inspect project state. The shell forms are `ling learning status`, `ling learning actions [query]`, and `ling learning memory`.

Reviews run only on demand and are mutually exclusive within a project. No new actions means no model request. Batches and review IDs are content-addressed, so crash recovery or an explicitly reset cursor can reuse a stored review instead of repeating it. The model can return at most eight JSON proposals, each citing action IDs from the current batch; unsupported edits and fabricated evidence are rejected. Evidence classes are derived from the ledger rather than trusted from model JSON: benchmark runs are `executed`, tool actions are `observed`, explicit foreground memory commands are `human`, and other message-derived evidence is `inferred`. Failed proposal parsing retains the response for audit, reports a sanitized error, and does not advance the cursor. Use `ling learning cursor skip` to advance past a poison batch without another model request, or `ling learning cursor reset` to reprocess from the beginning; neither deletes the ledger or history. Memory, proposal, and benchmark-definition mutations reload under per-project locks so concurrent writers do not overwrite one another.

Agent-originated memory and skill changes remain pending until explicit approval. Approval can modify only curated project memory or `.ling/skills/<name>/SKILL.md`; it cannot modify source code, global settings, providers, endpoints, or credentials. Skill updates carry a base hash and fail if the file changed after review. Direct `ling learning memory add <text>` and `remove <id>` are immediate because they are explicit user commands.

### Project benchmarks and verification discipline

The default and custom system prompts carry two core working disciplines. Strong-solver requires cue scanning, explicit budgets, killable hypotheses, executed counterexamples, invariants, trace tests, and a retrospective. Oracle-gate requires a third-party-checkable acceptance predicate or an explicit waiver; silence is not a waiver, and an unchecked clause is not met. Claims are distinguished as executed, estimated, or prose.

Define project-specific executable oracles in versionable `.ling/benchmarks.json`, or use the CLI:

```bash
ling benchmark add unit-oracle --stdout-contains PASS -- npm test
ling benchmark add needs-home --allow-env HOME -- ./scripts/check.sh
ling benchmark list
ling benchmark run unit-oracle
ling benchmark validate unit-oracle
ling benchmark runs unit-oracle
ling benchmark remove unit-oracle
```

Commands execute directly with an argument array, not through a shell. They run only when explicitly requested, stay inside the project working directory, have a 120-second default timeout, and capture at most 64,000 characters from each output stream. Assertions cover exit codes and required or forbidden output.

Benchmark children receive an isolated environment by default: only basic execution variables such as `PATH`, locale, timezone, temporary-directory, and required Windows variables are retained. Repeat `--allow-env NAME` to expose specific named variables. Use `--inherit-env` only for a trusted definition that explicitly needs the caller's complete environment; it cannot be combined with `--allow-env`. The ledger records the environment mode and variable names, never their values. This reduces accidental credential exposure but is not a kernel sandbox: trusted commands can still access anything available to the Ling Code process account.

Treat `.ling/benchmarks.json` as executable code: review changes and run only trusted definitions. Never store credential values in benchmark definitions; keep them in external credential storage or the environment. Each run hashes the definition file before and after execution, records both hashes, and fails if the file changed or disappeared. This detects concurrent or self-modification during a run; it does not make the ledger tamper-evident.

A definition may include `validation.positive` and `validation.negative` controls. `ling benchmark validate` executes both against the same assertions: the positive control must pass, the negative control must execute and fail, and both integrity checks must pass. This rejects vacuous oracles before their results are used as evidence. Validation controls are explicit runs and are persisted as `positive-control` and `negative-control` ledger actions.

Definitions receive content-addressed `bench_` IDs and hashes. Each executed result receives a deterministic `run_` ID and records duration, exit status, timeout, redacted output, and every assertion result in `actions.jsonl`. `/improve` and `ling improve` can therefore cite project benchmark evidence. A failing oracle is retained and makes `ling benchmark run` exit unsuccessfully. Different benchmark hashes are not silently treated as comparable, and no model-quality or cross-model improvement is claimed without executed comparable runs.

### Optional Decider gate

Decider is disabled by default and is never an implicit OpenRouter dependency. Enable it for one shell review with `ling improve --decider`, interactively with `/improve decider`, or explicitly in settings:

```json
{
  "learning": {
    "decider": {
      "enabled": true
    }
  }
}
```

The default decision model is `openrouter/perplexity/pplx-decider-v1.2`. OpenRouter credentials remain external, for example through `OPENROUTER_API_KEY` or Pi's existing credential storage. Decider is called only when the serialized review batch exceeds 32,000 characters. It returns typed decisions, not prose summaries: `shouldReview` must reach probability 0.55 before Ling performs the generative review. A low-probability batch advances the cursor without a Ling request; a Decider failure is retained, reported, and never bypassed silently.

For calibration, `ling improve --decider-shadow` and `/improve decider-shadow` record the typed gate decision but still run the Ling review. Shadow mode therefore can incur both model calls; it is not a free dry run. Decider cache identity includes the character threshold and minimum probability as well as the provider, model, prompt version, and batch state, so changing a threshold cannot reuse a decision made under different policy.

Tune `learning.review.batchActions`, `learning.review.maxInputTokens`, and `learning.decider.thresholdChars` or `minProbability` in settings when the endpoint and budget require different limits. Automatic background self-modification is not enabled.

## Migrating from Pi

The executable is `ling`, the project configuration directory is `.ling`, and the global agent directory defaults to `~/.ling/agent`. The environment overrides are now `LING_CODING_AGENT_DIR` and `LING_CODING_AGENT_SESSION_DIR`.

To migrate existing Pi settings and sessions, stop both CLIs and copy the old agent directory:

```bash
mkdir -p ~/.ling
cp -a ~/.pi/agent ~/.ling/agent
```

Review `models.json` before using it. Ling Code's `ling configure` command preserves unrelated providers but requires `--force` before replacing an existing `ling` entry. Project-local `.pi` directories are not renamed automatically; copy a project's `.pi/settings.json` to `.ling/settings.json` only after reviewing it.

The internal npm package names remain Pi's upstream workspace names to minimize fork divergence. This does not make an unpublished Ling npm package available, and upstream Pi self-update commands should not be treated as Ling Code releases.

## Verification boundary

The repository tests use local mock/faux endpoints and do not require API keys. They verify configuration, exact model selection, reasoning request serialization, and streamed reasoning/tool-call parsing. A live hosted service or GPU server must still be checked against its own served model ID, limits, parser flags, and authentication behavior before production use.
