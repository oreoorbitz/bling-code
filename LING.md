# Bling Code

Bling Code is a full fork of [Pi](https://github.com/earendil-works/pi), focused on Ling 3.1 Flash while retaining Pi's CLI, TUI, tools, extensions, sessions, and automatic compaction. It is a clean-room harness configuration, not a copy of InclusionAI's closed LingCode implementation and not a reimplementation of model weights.

## Model policy

- **Ling is served through OpenRouter by default.** InclusionAI does not host the model itself; OpenRouter routes to providers such as DeepInfra. Bling Code uses Pi's built-in `openrouter` provider, so model IDs, prices, context windows, output limits, and image support come from its model catalog.
- **Ling 3.1 Flash is the default profile** (`openrouter/inclusionai/ling-3.1-flash`). With an OpenRouter credential and no saved default, Bling Code selects it ahead of other providers' defaults.
- **Ling 3.0 Flash and Ling 3.0 Flash VL are explicitly selectable** with `--profile 3.0` and `--profile 3.0-vl`. A Ling default or session is never substituted silently with another model or Ling generation.
- **Credentials stay external:** `OPENROUTER_API_KEY` or Pi's stored `/login` credential. No API key is written to `models.json`.
- **A self-hosted endpoint remains optional** through `--base-url`; see [Self-hosted endpoint](#self-hosted-endpoint).

Each profile applies the vendor-recommended sampling from the model's `generation_config.json`:

| Profile | OpenRouter model | Pinned upstream | Temperature | Top P | Top K |
| --- | --- | --- | ---: | ---: | ---: |
| `3.1` | `inclusionai/ling-3.1-flash` | `novita` | 1.0 | 0.95 | 20 |
| `3.0` | `inclusionai/ling-3.0-flash` | `novita` | 0.6 | 0.95 | 20 |
| `3.0-vl` | `inclusionai/ling-3.0-flash-vl` | `deepinfra` | 1.0 | 0.95 | 20 |

OpenRouter otherwise routes each request to any host serving the model, and hosts differ in quantization, context, and speed. For Ling 3.1, DeepInfra serves FP4 weights while Novita does not publish its precision (InclusionAI's release is FP8). Splitting one run across hosts would make results uninterpretable, so each profile pins one upstream with fallbacks disabled. Novita serves Ling 3.1 and 3.0 with the full 262k context; DeepInfra is the only host for 3.0 VL. If the pinned host is unavailable, requests fail rather than move to another host.

Model references: [Ling 3.1 Flash](https://huggingface.co/inclusionAI/Ling-3.1-flash), [Ling 3.0 Flash](https://huggingface.co/inclusionAI/Ling-3.0-flash), [Ling 3.0 Flash VL](https://huggingface.co/inclusionAI/Ling-3.0-flash-vl), [Ling cookbook](https://github.com/inclusionAI/ling-cookbook), and [Ling 2.5 architecture](https://github.com/inclusionAI/Ling-V2.5).

## Configure OpenRouter

Bling Code requires Node.js 22.19 or newer. From this source checkout:

```bash
npm install --ignore-scripts
npm run build
```

Set an OpenRouter API key and select a profile:

```bash
export OPENROUTER_API_KEY='your-openrouter-key'
node packages/coding-agent/dist/bundle/cli.js configure
node packages/coding-agent/dist/bundle/cli.js
```

The variable must be named `OPENROUTER_API_KEY`. Alternatively, run `/login` in the interactive UI to store an OpenRouter credential in `~/.bling/agent/auth.json`.

`bling configure` adds the profile's sampling parameters and upstream pin (`compat.openRouterRouting` with `only` and `allow_fallbacks: false`) as a `modelOverrides` entry under `providers.openrouter` in `~/.bling/agent/models.json` and selects the exact `openrouter/<model-id>` default in `settings.json`. Other providers, other overrides, and other fields of the same override are preserved. Run it again with `--profile 3.0` or `--profile 3.0-vl` to switch profiles, or with `--upstream <slug>` to pin another host, for example `--upstream deepinfra/fp4` for a quantization comparison. Slugs are listed per model at `https://openrouter.ai/api/v1/models/<model-id>/endpoints`.

Run `bling doctor` after setup. For OpenRouter it checks the credential, the saved Ling default against the model catalog, the sampling override, and the upstream pin, without making an API request or displaying credential values. A non-Ling saved default is a warning rather than an error; explicit non-Ling selection remains supported.

## Self-hosted endpoint

Configure a local vLLM or SGLang server with the Ling chat-template reasoning controls:

```bash
export LING_API_KEY=local-development-key
node packages/coding-agent/dist/bundle/cli.js configure \
  --base-url http://localhost:30000/v1 \
  --dialect chat-template
```

The environment variable above is an example placeholder for a local server, not a credential stored by Bling Code. If the local server has no authentication, configure its expected dummy value in the environment; do not put a real secret on the command line.

To select Ling 3.0 instead, run a separate explicit configuration:

```bash
node packages/coding-agent/dist/bundle/cli.js configure \
  --base-url http://localhost:30000/v1 \
  --profile 3.0 \
  --model-id inclusionAI/Ling-3.0-flash \
  --dialect chat-template \
  --force
```

This writes a custom `ling` provider. `--force` is required to replace an existing `ling` provider entry. Configuration rejects a recognizable model ID that does not match the profile's generation or vision variant. Endpoint profiles default to a **262,144-token served context** and **32,768 output tokens**; Ling 3.1's 1M architectural context is not assumed to be available. Output tokens cannot exceed the configured context window. `bling doctor` checks the endpoint, reasoning dialect, model limits, credential reference, and exact saved default when the `ling` provider is selected.

### Dialects

| Dialect | Intended endpoint | Reasoning request field |
| --- | --- | --- |
| `chat-template` | vLLM/SGLang with Ling 3 parsers | `chat_template_kwargs.enable_thinking` and `preserve_thinking` |
| `ling` | First-party Ant Ling OpenAI-compatible API | `thinking.type: enabled/disabled` |
| `openrouter` | An OpenRouter-compatible proxy | OpenRouter reasoning controls |

For local serving, enable the Ling reasoning and tool-call parsers. With vLLM, the model cards recommend `--reasoning-parser ling3 --tool-call-parser ling3 --enable-auto-tool-choice`. The endpoint must return standard OpenAI streaming responses; reasoning may be in `reasoning_content`, `reasoning`, or `reasoning_text`.

The default request compatibility also uses `max_tokens`, disables the OpenAI `store` field, and sends system rather than developer messages. Edit `models.json` if a particular endpoint has different limits or compatibility behavior. See `packages/coding-agent/docs/models.md` for all configuration fields.

## Long-running coding sessions

Pi's existing behavior is retained:

- Automatic context compaction remains enabled, with 16,384 reserved tokens and 20,000 recent tokens kept by default.
- Use `bling --continue` to continue the latest project session or `bling --resume` to select a session.
- The system prompt asks the model to track remaining work, run checks, distinguish executed work from proposals, and inspect final changes.
- A missing or unauthenticated Ling default (`openrouter/inclusionai/ling-*` or the self-hosted `ling` provider) does not fall through to another authenticated provider. Resuming a Ling session follows the same rule even if the saved default now names another provider. Select another model explicitly with `--provider` and `--model` if desired.
- Blank or thinking-only summarization responses are rejected rather than saved as empty compaction checkpoints.

The catalog's or endpoint's context and output limits control when compaction occurs. Do not set a 1M context merely because the model architecture supports it.

## Project-local learning

Bling Code keeps learning state separate for each project under `.bling/learning/`:

- `actions.jsonl` is an append-only ledger of finalized messages, tool executions, benchmark runs, and subagent runs, including provider-returned reasoning. Deterministic `act_`, `tool_`, and `run_` IDs make replay idempotent. Tool records include `parentActionId` when the requesting assistant message was logged, linking execution evidence back to that model action.
- `memory.json` is bounded curated project memory, with a generated `MEMORY.md` view. Its default total budget is 6,000 characters; overflow fails rather than silently evicting older facts. Hand-edited duplicate, unsafe, credential-shaped, or over-budget state is rejected by normal consumers; review-only loading can still compact oversized memory. Curated memory enters the system prompt only for trusted projects.
- `reviews.jsonl` retains generative review responses and reasoning, typed Decider results, and provider-returned failures. `proposals.json` tracks pending, rejected, and applied improvements. `cursor.json` records the last processed action ID.
- The directory's `.gitignore` excludes learning state from version control. Credential-shaped fields and common credential patterns are redacted, but redaction is best-effort; do not paste secrets into prompts, tools, or memory.

The complete action history is retained and can grow. Review prompts are bounded independently: the defaults are 80 actions and 180,000 estimated input tokens per batch. The budget covers actions, project memory, and skill snapshots together; oversized snapshots are compacted or omitted with explicit counts. This lets a review use Ling's long context without sending the entire project ledger.

### Review and approve improvements

Run a review interactively with `/improve`, or from the shell:

```bash
bling improve
bling learning list
bling learning show <proposal-id>
bling learning approve <proposal-id>
```

Interactive equivalents are `/learning pending`, `/learning show`, `/learning approve`, and `/learning reject`. Use `/learning status`, `/learning actions [query]`, and `/learning memory` to inspect project state. The shell forms are `bling learning status`, `bling learning actions [query]`, and `bling learning memory`.

Reviews run only on demand and are mutually exclusive within a project. No new actions means no model request. Batches and review IDs are content-addressed, so crash recovery or an explicitly reset cursor can reuse a stored review instead of repeating it. The model can return at most eight JSON proposals, each citing action IDs from the current batch; unsupported edits and fabricated evidence are rejected. Evidence classes are derived from the ledger rather than trusted from model JSON: benchmark runs are `executed`, tool actions are `observed`, explicit foreground memory commands are `human`, and other message-derived evidence is `inferred`. Failed proposal parsing retains the response for audit, reports a sanitized error, and does not advance the cursor. Use `bling learning cursor skip` to advance past a poison batch without another model request, or `bling learning cursor reset` to reprocess from the beginning; neither deletes the ledger or history. Memory, proposal, and benchmark-definition mutations reload under per-project locks so concurrent writers do not overwrite one another.

Agent-originated memory and skill changes remain pending until explicit approval. Approval can modify only curated project memory or `.bling/skills/<name>/SKILL.md`; it cannot modify source code, global settings, providers, endpoints, or credentials. Skill updates carry a base hash and fail if the file changed after review. Direct `bling learning memory add <text>` and `remove <id>` are immediate because they are explicit user commands.

### Project benchmarks and verification discipline

The default and custom system prompts carry two core working disciplines. Strong-solver requires cue scanning, explicit budgets, killable hypotheses, executed counterexamples, invariants, trace tests, and a retrospective. Oracle-gate requires a third-party-checkable acceptance predicate or an explicit waiver; silence is not a waiver, and an unchecked clause is not met. Claims are distinguished as executed, estimated, or prose.

Define project-specific executable oracles in versionable `.bling/benchmarks.json`, or use the CLI:

```bash
bling benchmark add unit-oracle --stdout-contains PASS -- npm test
bling benchmark add needs-home --allow-env HOME -- ./scripts/check.sh
bling benchmark list
bling benchmark run unit-oracle
bling benchmark validate unit-oracle
bling benchmark runs unit-oracle
bling benchmark remove unit-oracle
```

Commands execute directly with an argument array, not through a shell. They run only when explicitly requested, stay inside the project working directory, have a 120-second default timeout, and capture at most 64,000 characters from each output stream. Assertions cover exit codes and required or forbidden output.

Benchmark children receive an isolated environment by default: only basic execution variables such as `PATH`, locale, timezone, temporary-directory, and required Windows variables are retained. Repeat `--allow-env NAME` to expose specific named variables. Use `--inherit-env` only for a trusted definition that explicitly needs the caller's complete environment; it cannot be combined with `--allow-env`. The ledger records the environment mode and variable names, never their values. This reduces accidental credential exposure but is not a kernel sandbox: trusted commands can still access anything available to the Bling Code process account.

Treat `.bling/benchmarks.json` as executable code: review changes and run only trusted definitions. Never store credential values in benchmark definitions; keep them in external credential storage or the environment. Each run hashes the definition file before and after execution, records both hashes, and fails if the file changed or disappeared. This detects concurrent or self-modification during a run; it does not make the ledger tamper-evident.

A definition may include `validation.positive` and `validation.negative` controls. `bling benchmark validate` executes both against the same assertions: the positive control must pass, the negative control must execute and fail, and both integrity checks must pass. This rejects vacuous oracles before their results are used as evidence. Validation controls are explicit runs and are persisted as `positive-control` and `negative-control` ledger actions.

Definitions receive content-addressed `bench_` IDs and hashes. Each executed result receives a deterministic `run_` ID and records duration, exit status, timeout, redacted output, and every assertion result in `actions.jsonl`. `/improve` and `bling improve` can therefore cite project benchmark evidence. A failing oracle is retained and makes `bling benchmark run` exit unsuccessfully. Different benchmark hashes are not silently treated as comparable, and no model-quality or cross-model improvement is claimed without executed comparable runs.

### Control harness for benchmarking

To measure Bling's harness changes, run the same model and host with `--harness stock` (or `harness.profile: "stock"`) and with the default `bling` profile. `stock` uses upstream Pi's system prompt text, without the strong-solver and oracle-gate section, the extra rules, the Bling identity text, curated project memory, or the `project_memory` tool. Model selection, sampling, and action logging are unchanged. Ledger records in `actions.jsonl` carry `harnessProfile`, and `bling benchmark run|validate [--harness <bling|stock>]` records which arm a benchmark result belongs to; `bling benchmark runs` lists it. Records written before this feature have no profile. Compare only runs with the same benchmark definition hash and different profiles.

### Subagent roles

The `subagents` setting defines named roles that Ling can later delegate to: `scout` (read-only investigation) and `coder` (one file, one attempt). The `scout` and `code_file` tools below use the active roles. Check the configuration offline with `bling doctor`.

```json
{
  "subagents": {
    "armLabel": "qwen-fp8",
    "active": { "scout": "qwen-fp8-scout", "coder": "ling-coder" },
    "roles": {
      "qwen-fp8-scout": {
        "kind": "scout",
        "provider": "openrouter",
        "model": "qwen/qwen3.8-27b",
        "upstream": "chutes/fp8",
        "sampling": { "temperature": 0.2, "top_p": 0.9, "top_k": 20 }
      },
      "ling-coder": {
        "kind": "coder",
        "provider": "openrouter",
        "model": "inclusionai/ling-3.1-flash",
        "upstream": "novita",
        "sampling": { "temperature": 1.0, "top_p": 0.95, "top_k": 20 },
        "budgets": { "maxCostUsd": 0.5 }
      }
    }
  }
}
```

Each role names an exact provider and model. OpenRouter roles must name an `upstream` host; the pin is applied per role with fallbacks disabled, so the same model can appear in several roles on different hosts. There is no fallback: a missing model, missing credential, or invalid role is an error, never a switch to another model or host. A role's `sampling` replaces the catalog sampling instead of merging with it.

The pin sent to OpenRouter for every role is `provider: { only: [upstream], allow_fallbacks: false, require_parameters: true }`. `require_parameters` makes OpenRouter reject the request instead of silently dropping a parameter (sampling, tools, reasoning) that the pinned host does not support. Two optional per-role fields map to more routing fields: `zdr: true` sends `provider.zdr` (only Zero Data Retention endpoints) and `dataCollection: "deny"` sends `provider.data_collection` (only hosts that do not collect or train on data). If the pinned host does not meet such a constraint, the request fails; nothing else is tried.

```json
{ "kind": "coder", "provider": "openrouter", "model": "inclusionai/ling-3.1-flash", "upstream": "novita", "zdr": true, "dataCollection": "deny" }
```

#### Round-1 arms

The roles below are the round-1 scout and coder arms from `plans/subagent-roles-and-arms.md`. Every scout has thinking `off` (OpenRouter `reasoning.effort: "none"`) because scouts are input-heavy and output-light and reasoning tokens are the main avoidable cost; raise it only if extraction quality is inadequate. Pick an arm per run with `--scout <role>` and `--coder <role>`. The `active` block only sets the defaults.

`ling-coder-oneshot` and `ling-coder-repair2` are the same model, host, and sampling with `maxOracleRuns` 1 (a sanity check, effectively one shot) and 3 (the coder may run the oracle and fix its own mistakes inside one `code_file` call). Repair rounds are in-task iteration, not a retry: Ling still owns re-delegation. The other coders can get the same two variants by copying the role and changing `maxOracleRuns`. Role names are part of the arm identity, so the variants are separate arms.

```json
{
  "subagents": {
    "armLabel": "round1",
    "active": { "scout": "ling30-scout", "coder": "ling-coder-oneshot" },
    "roles": {
      "ling30-scout": {
        "kind": "scout", "provider": "openrouter", "model": "inclusionai/ling-3.0-flash", "upstream": "novita",
        "thinking": "off", "sampling": { "temperature": 0.2, "top_p": 0.9, "top_k": 20 }
      },
      "gptoss20-scout": {
        "kind": "scout", "provider": "openrouter", "model": "openai/gpt-oss-20b", "upstream": "coreweave/fp4",
        "thinking": "off", "sampling": { "temperature": 0.2, "top_p": 0.9 }
      },
      "mercury25-scout": {
        "kind": "scout", "provider": "openrouter", "model": "inception/mercury-2.5", "upstream": "inception",
        "thinking": "off", "sampling": { "temperature": 0.2 }
      },
      "qwen-fp8-scout": {
        "kind": "scout", "provider": "openrouter", "model": "qwen/qwen3.8-27b", "upstream": "chutes/fp8",
        "thinking": "off", "sampling": { "temperature": 0.2, "top_p": 0.9, "top_k": 20 }
      },
      "ling-coder-oneshot": {
        "kind": "coder", "provider": "openrouter", "model": "inclusionai/ling-3.1-flash", "upstream": "novita",
        "sampling": { "temperature": 1.0, "top_p": 0.95, "top_k": 20 },
        "budgets": { "maxOracleRuns": 1, "maxDiffLines": 300, "maxOutputTokens": 30000 }
      },
      "ling-coder-repair2": {
        "kind": "coder", "provider": "openrouter", "model": "inclusionai/ling-3.1-flash", "upstream": "novita",
        "sampling": { "temperature": 1.0, "top_p": 0.95, "top_k": 20 },
        "budgets": { "maxOracleRuns": 3, "maxDiffLines": 300, "maxOutputTokens": 30000 }
      },
      "glm53-cheap": {
        "kind": "coder", "provider": "openrouter", "model": "z-ai/glm-5.3-flash", "upstream": "open-inference/fp4",
        "sampling": { "temperature": 0.2, "top_p": 0.9 },
        "budgets": { "maxDiffLines": 300, "maxOutputTokens": 30000 }
      },
      "glm53-fast": {
        "kind": "coder", "provider": "openrouter", "model": "z-ai/glm-5.3-flash", "upstream": "wafer/nvfp4",
        "sampling": { "temperature": 0.2, "top_p": 0.9 },
        "budgets": { "maxDiffLines": 300, "maxOutputTokens": 30000 }
      },
      "dsv4-flash": {
        "kind": "coder", "provider": "openrouter", "model": "deepseek/deepseek-v4-flash-0731", "upstream": "baidu/fp8",
        "sampling": { "temperature": 0.2, "top_p": 0.9 },
        "budgets": { "maxTurns": 12, "maxDiffLines": 300, "maxOutputTokens": 20000 }
      },
      "haiku55": {
        "kind": "coder", "provider": "openrouter", "model": "anthropic/claude-haiku-5.5", "upstream": "anthropic",
        "budgets": { "maxDiffLines": 300, "maxOutputTokens": 30000 }
      }
    }
  }
}
```

Notes on the arms. `haiku55` has no `sampling` because the `anthropic` host lists none of the sampling parameters as supported; the default 49000-token request bound keeps its prompts under the model's 100K price cliff. `dsv4-flash` had long trajectories in published coding benchmarks, hence the tighter `maxOutputTokens`. Prices and hosts change: recheck each pin on `https://openrouter.ai/api/v1/models/<id>/endpoints` right before a run and record them with the results (for example, `z-ai/glm-5.3-flash` on `open-inference/fp4` was listed at about $0.040 input and $0.31 output per 1M tokens on 2026-10-24, above the $0.018 / $0.106 in the plan). Catalog prices in `models.json` drive `cost`, so update them too.

Set `BLING_SUBAGENT_SCOUT` or `BLING_SUBAGENT_CODER` to a role name to override the active role, or to `none` to disable that kind. Sampling parameters a host does not list as supported fail validation, because with `require_parameters` the request would have no eligible host. The built-in table (`UNSUPPORTED_SAMPLING_BY_UPSTREAM` in `src/core/subagents/roles.ts`, keyed by the upstream slug before `/`) was built from the endpoints API on 2026-10-24 for the models in the documented arms: `inception` supports `temperature` only; `cerebras` lacks `top_k`, `min_p`, `repetition_penalty`; `baidu` supports `temperature` and `top_p`; `anthropic` supports none of them; `novita`, `coreweave`, and `chutes` lack `min_p`; `open-inference` and `wafer` support all. Hosts not in the table are not checked. Recheck each host's `supported_parameters` on OpenRouter's endpoints page (`https://openrouter.ai/api/v1/models/<id>/endpoints`) before benchmark runs.

### Subagent tools: scout and code_file

When a kind has an active role, Ling gets the matching tool. Ling chooses the question or task; the model, host, sampling, and budgets are fixed by the active role, so one run is one arm.

`scout(question, context?, startPaths?)` investigates read-only and returns JSON: findings (claim, evidence with path and line range, confidence), unresolved questions, a suggested next action (never performed), and run metadata. The harness checks every cited range against the real file and sets `verified`; treat `verified: false` as unreliable. A scout has `read`, `grep`, `find`, `ls` confined to the project root (symlinks that leave it are rejected, as are credential-looking names: `.env*`, `.npmrc`, `.netrc`, `.pypirc`, `.pgpass`, `.htpasswd`, `.git-credentials`, `.dockercfg`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `*.tfstate`, `service-account*.json`, `secrets.{json,yml,yaml,toml,env}`, `credentials*`, ssh keys (`id_rsa*` and similar), `auth.json`, and the directories `.git`, `.ssh`, `.aws`, `.gnupg`, `.docker`, `.kube`; `grep` and `find` skip them too), and `run_script`, which runs only scripts named in `subagents.scripts` (argv, no shell, isolated environment, bounded output). Scripts are honored only from global settings (`~/.bling/agent/settings.json`); a project's `.bling/settings.json` may define roles when the project is trusted, but its `subagents.scripts` are ignored and `bling doctor` warns about them. It has no `bash`. A scout that stops without calling `report` returns outcome `no_report` with its last text in `rawText`.

`code_file(path, change, contract?, snippets?, oracle)` makes one change to one file in one attempt. `oracle` is an argv array (`{ command, args, timeoutMs? }`), never a shell string. Edit and write are enforced to that single path, including through `..`, absolute spellings, `~`, and symlinks; the target must exist or have an existing parent directory and must not be a symlink. The coder can run only the oracle through `run_oracle` (at most `maxOracleRuns`, default 1). After it stops, the harness runs the oracle itself; that result decides the outcome: `passed`, `oracle_failed`, `no_change`, `escalated`, `diff_too_large`, or an early stop (`error`, `timeout`, `aborted`, `budget_*`). A failed run is not reverted. The result carries the unified diff, file hashes, the oracle result, and the coder's uncertainties and interface changes. Ling decides whether to keep, fix, or revert.

Escalation. Instead of working around a limit, the coder can end with the terminal tool `escalate { reason, detail, filesNeeded? }`, where `reason` is `scope_expansion` (the task needs a change outside the target file), `unresolved_failure` (it could not make the change work within the target), or `ambiguous_spec` (the brief does not say what to do). The run ends with outcome `escalated`, distinct from `oracle_failed` (the coder finished and the check failed). `coder.escalation` carries the reason, detail, and files needed; any edit already made stays on disk and is reported in the diff, and the harness does not run the oracle for an escalated run. The coder prompt tells it to escalate rather than add code to the target to compensate for a change that belongs in another file. Ling decides what happens next (split the task, widen the brief, do it itself); there is no automatic retry.

Diff budget. `budgets.maxDiffLines` (coder only, unset by default) bounds the changed lines in the target, counted as lines added plus lines removed (`coder.diffLines` is always reported). It is checked after the coder stops, not during the run. When it is exceeded the outcome is `diff_too_large`. Consistent with the no-auto-revert rule, the file is left as written and the diff is returned (capped at 20000 characters); the harness still runs the oracle and reports it, but the outcome stays `diff_too_large` even if the oracle passes. Ling reviews or reverts. A run that ended early (`budget_*`, `error`, `timeout`, `aborted`) keeps that outcome.

Verdicts. When any role is active Ling also gets `subagent_verdict { runId, verdict: "accepted" | "rejected", reason }`. It changes no file; it writes a `subagent_verdict` ledger record linked to the run by `runId`, so acceptance rate is measured from Ling's actual decision instead of inferred from later edits. The `runId` must belong to a `scout` or `code_file` result in the current session branch. Verdicts are append-only: a later verdict for the same run replaces the earlier one in the report.

Subagents cannot spawn subagents, switch models, retry, or fall back to another model or host. Each role has budgets (defaults: scout 20 turns, coder 12 turns; 400000 cumulative tokens; 49000 tokens in one request; 180 s scout, 300 s coder; no cost cap): `maxTurns`, `maxTotalTokens`, `maxContextTokens`, `timeoutMs`, `maxCostUsd`, `maxOracleRuns`, plus two unset-by-default limits: `maxOutputTokens` and `maxDiffLines` (coder). `maxOutputTokens` is the cumulative billed output over the run, including reasoning tokens (providers bill them as output), and trips its own outcome `budget_output`; it is separate from `maxTotalTokens`, which also counts input and cache tokens, so a reasoning-heavy model can be capped without capping its prompts. The first limit reached stops the run with its own outcome. Each run returns a summary with token usage (input, output, cache read, cache write), cost from catalog prices, turns, duration, the requested upstream pin, the hosts that actually served the requests, and `upstreamMismatch` (a served host does not match the pin), `usage.reasoning` (reasoning tokens, a subset of `output`; present only when the provider reports a breakdown, such as OpenRouter's `completion_tokens_details.reasoning_tokens`), `timeToFirstToolCallMs` (run start to the first assistant message that contained a tool call; absent if none did), and `failedToolCalls` (tool calls that errored or were blocked; scope violations are included, `scopeViolations` counts only those). A role that sets `maxCostUsd` on a model with no pricing is rejected, because the cost cap could never trip. Results sent to Ling are capped at about 12000 characters.

This is not a sandbox. The harness limits what the child's tools can touch; it does not contain a hostile oracle, script, or model, and the credential-name filter is best-effort and name based: a secret stored under another name, or reachable through a hard link to a denied file (the scope resolves symlinks, not hard links), can still be read or appear in `grep` output. Hard-linked files are not refused outright because package managers such as pnpm build `node_modules` from hard links. Prompts and file contents are sent to the pinned third-party host. The unrelated subprocess-based example in `packages/coding-agent/examples/extensions/subagent` is unchanged.

### Measuring cost-of-pass

Every scout and coder run is written to `.bling/learning/actions.jsonl` as a `subagent` record (`sub_` ID): role, role name and identity hash, provider/model, requested upstream, served upstreams, token usage (input, output, cache read, cache write, and reasoning when reported), cost, turns, duration, time to first tool call, failed tool calls, outcome, oracle result, a hash of the diff, changed diff lines, the escalation reason, and the parent link (`parentSessionId`, `parentToolCallId`, and `parentActionId` when the requesting assistant message is in the session). Child transcripts are not stored. Ling's own messages remain `message` records and count as role `primary`. Each `subagent_verdict` call adds a `subagent_verdict` record (`verdict_` ID) with the run ID, verdict, reason, role, and the same benchmark run tag. Records are written only when `learning.enabled` and `learning.actionLog` are on; a failed ledger write never fails the tool call and is reported as `ledgerWarning` in the result details.

`bling benchmark run` gives each run a random run ID and exports it to the child process as `BLING_BENCHMARK_RUN_ID`, together with `BLING_BENCHMARK_ARM`. These are injected by the harness even in `isolated` mode and are not part of `envAllowlist`. Any Bling session started inside the run tags its message, tool, and subagent records with the run ID, and the benchmark record stores `runId` and `armId`.

An arm is the harness profile plus the active role configuration: `<harness>:<armLabel|unlabeled>:<hash>`, where the hash covers each active role's name, model, upstream pin, sampling, thinking level, and budgets (`none` when no role is active). Select an arm per run:

```bash
bling benchmark run parser-fix --harness bling --scout mercury-3-scout --coder qwen-fp8-coder
bling benchmark run parser-fix --harness stock --scout none --coder none
bling benchmark report parser-fix
bling benchmark report --json
```

`--scout` and `--coder` take a role from `subagents.roles` or `none`; they are exported to the child as `BLING_SUBAGENT_SCOUT` and `BLING_SUBAGENT_CODER`. The arm ID is computed from the environment the child will see (only these overrides in isolated mode, the caller environment plus overrides with `--inherit-env`). The child needs the same settings and credentials to resolve roles, so allow what it needs, for example `--allow-env HOME`.

`report` groups passing and failing benchmark runs (not validation controls) by arm and prints, per arm: runs, passed, total cost, cost-of-pass (total cost across all roles, including failed runs, divided by passed runs; `n/a` with no passes), cost by role with token counts (including reasoning tokens when recorded), per-role behavior (runs, acceptance rate as accepted over accepted plus rejected with the unjudged count, escalation rate, runs over `maxDiffLines`, failed tool calls, scope violations, p50 and p95 time to first tool call), p50 and p95 wall-clock (nearest rank; also over passing runs only), subagent outcomes, served upstreams, upstream mismatches (a subagent run served by a host that does not match its pin), a warning for roles that recorded tokens but zero cost, and runs without primary accounting (no linked assistant message was found). Costs use catalog prices, so check that `models.json` prices for each pinned host are current before comparing arms.

Limitation: the ledger is per project root. The child must run `bling` in the same project so its records land in the same `actions.jsonl`; a run whose child never records a session shows up under runs without primary accounting. Wall-clock is the benchmark command's duration.

### Optional Decider gate

Decider is disabled by default and is never an implicit OpenRouter dependency. Enable it for one shell review with `bling improve --decider`, interactively with `/improve decider`, or explicitly in settings:

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

For calibration, `bling improve --decider-shadow` and `/improve decider-shadow` record the typed gate decision but still run the Ling review. Shadow mode therefore can incur both model calls; it is not a free dry run. Decider cache identity includes the character threshold and minimum probability as well as the provider, model, prompt version, and batch state, so changing a threshold cannot reuse a decision made under different policy.

Tune `learning.review.batchActions`, `learning.review.maxInputTokens`, and `learning.decider.thresholdChars` or `minProbability` in settings when the endpoint and budget require different limits. Automatic background self-modification is not enabled.

## Migrating from Pi

The executable is `bling`, the project configuration directory is `.bling`, and the global agent directory defaults to `~/.bling/agent`. The environment overrides are now `BLING_CODING_AGENT_DIR` and `BLING_CODING_AGENT_SESSION_DIR`.

To migrate existing Pi settings and sessions, stop both CLIs and copy the old agent directory:

```bash
mkdir -p ~/.bling
cp -a ~/.pi/agent ~/.bling/agent
```

Review `models.json` before using it. Bling Code's `bling configure` command preserves unrelated providers but requires `--force` before replacing an existing `ling` entry. Project-local `.pi` directories are not renamed automatically; copy a project's `.pi/settings.json` to `.bling/settings.json` only after reviewing it.

The CLI package is named `blingcode`. The other workspace packages keep Pi's upstream `@earendil-works/pi-*` names to minimize fork divergence; the `bling` executable bundles them. Extensions still import `@earendil-works/pi-coding-agent`, which the extension loader provides. `blingcode` is not published to npm yet, and upstream Pi self-update commands should not be treated as Bling Code releases.

## Verification boundary

The repository tests use local mock/faux endpoints and do not require API keys. They verify configuration, exact model selection, reasoning request serialization, and streamed reasoning/tool-call parsing. A live hosted service or GPU server must still be checked against its own served model ID, limits, parser flags, and authentication behavior before production use.
