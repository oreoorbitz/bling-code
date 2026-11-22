# Affordable Single-File Coding Agents on OpenRouter

**Research date:** October 25, 2026  
**Workload:** An orchestrator-directed coding worker that can read limited dependencies, edit exactly one assigned file, use tools, and run focused tests. The worker does not make repository-wide plans or integrate multi-file changes.

## Executive conclusion

For this role, the quality bar is substantially higher than for a scout. The worker must:

- Interpret a bounded implementation instruction.
- Read the target file and limited dependencies.
- Make a coherent patch.
- Use tools reliably.
- Run focused tests and respond appropriately to failures.
- Stop when the task requires changes beyond its assigned file.

**The strongest initial candidates are GLM 5.3 Flash and DeepSeek V4 Flash 0731.** Qwen3 Coder 30B is worth testing for simpler patches, Mercury 2.5 is a speed experiment, and Haiku 5.5 is the higher-cost quality baseline.

Prices and provider availability were checked against OpenRouter’s public API on October 25, 2026. Throughput figures are recent observations, not sustained-performance guarantees.

## Candidate shortlist

| Candidate and route | Input / output per MTok | Context | Speed and coding evidence | Assessment |
|---|---:|---:|---|---|
| **GLM 5.3 Flash — OpenInference or Wafer** | OpenInference **$0.0184 / $0.1062**; Wafer **$0.064 / $0.200** | 1M | Wafer approximately **145 tok/s**. Artificial Analysis lists **71.5 Coding Index** and **50.9 Agentic Index**. | **Best default candidate.** Strong relevant benchmark signals, many providers, and inexpensive enough for routine delegation. [Benchmark comparison](https://openrouter.ai/compare/z-ai/glm-5.3-flash/openai/gpt-6-sol) and [provider endpoints](https://openrouter.ai/z-ai/glm-5.3-flash/endpoints) |
| **DeepSeek V4 Flash 0731 — Baidu, Relace, or Wafer** | Baidu **$0.0444 / $0.1333**; Relace **$0.0422 / $0.1763**; Wafer **$0.130 / $0.230** | 1M | Approximately **82–90 tok/s** model-wide p50; **69.1 Coding Index** and **41.0 Agentic Index**. | **Best price/throughput alternative.** Particularly attractive for bounded implementation with strict step and output budgets. [OpenRouter comparison](https://openrouter.ai/compare/deepseek/deepseek-v4-flash-0731/openai/gpt-5.6-luna) |
| **Qwen3 Coder 30B A3B Instruct — SiliconFlow** | **$0.070 / $0.280** | 262K | Up to approximately **115 tok/s** | **Candidate for straightforward transformations and bug fixes.** The non-reasoning instruct formulation may simplify budget control, but the cheap tool-capable route is concentrated on one provider. [OpenRouter listing](https://openrouter.ai/qwen/qwen3-coder-30b-a3b-instruct) |
| **Mercury 2.5 — Inception** | **$0.040 / $0.150**, currently marked 80% off | 260K | OpenRouter p50 approximately **168 tok/s**; vendor advertises 1,107 tok/s | **Speed-only challenger, not the quality default.** It explicitly targets coding subagents, but comparable coding evidence is weaker than for GLM or DeepSeek. [Model listing](https://openrouter.ai/inception/mercury-2.5) and [p50 comparison](https://openrouter.ai/compare/inception/mercury-2.5/openai/gpt-6-luna-pro/openai/gpt-6-luna/anthropic/claude-haiku-5.5) |
| **Claude Haiku 5.5 — Google Vertex or Anthropic** | **$0.10 / $0.50** at ≤100K; higher price band above 100K | 1M | Up to approximately **169 tok/s** on Google Vertex | **Best quality-control and escalation candidate.** More expensive, but a useful baseline for patch acceptance and debugging reliability. [OpenRouter listing](https://openrouter.ai/anthropic/claude-haiku-5.5) |
| **MiniMax M3.1 Flash — InferenceNet or first-party** | InferenceNet **$0.10 / $0.55**; first-party **$0.15 / $0.60** | 1M | Approximately **64 tok/s** p50 | **Optional step-up arm.** MiniMax reports strong DeepSWE results, but it is slower and more expensive, reasoning cannot be disabled, and independent coverage flags hallucination concerns. [OpenRouter comparison](https://openrouter.ai/compare/minimax/minimax-m3.1-flash/poolside/laguna-xs-2.1) and [MiniMax model announcement](https://www.minimax.io/news/minimax-m31-flash) |

## Recommended ranking

### 1. GLM 5.3 Flash: default coding-worker candidate

It has the best combination of:

- Low endpoint prices.
- Relevant coding and agentic benchmark signals.
- Long context.
- Tool-capable providers.
- Multiple explicit routing choices.
- A reasonably fast route through Wafer.

Test two separate configurations:

- **GLM-cheap:** OpenInference, for cost-of-pass evaluation.
- **GLM-fast:** Wafer, for interactive latency.

Do not let OpenRouter silently move between them during a comparison.

### 2. DeepSeek V4 Flash 0731: strongest alternative

DeepSeek is close to GLM on the published indices and has attractive throughput. However, cheaper tokens do not guarantee cheaper completed patches.

Together’s DeepSWE comparison reported:

| Metric | DeepSeek V4 Flash 0731 | GPT-5.6 Luna |
|---|---:|---:|
| Pass@1, official scoring | 53.3% | 67.2% |
| Average cost per rollout | $0.10 | $0.61 |
| Median trajectory | 148 steps | 92 steps |
| Median output tokens | 104K | 70K |

Source: [DeepSWE: An Open, Reproducible Evaluation of Coding Agents](https://www.together.ai/blog/deepswe).

This is why the single-file role needs **hard tool-call, retry, and output limits**. DeepSeek could win decisively on cost-of-pass for easy patches while wasting its advantage on ambiguous tasks.

### 3. Qwen3 Coder 30B: simple-patch specialist

This is worth testing on:

- Mechanical refactors.
- Type-error fixes.
- Small localized bug fixes.
- Adding a function with a precise signature.
- Updating one file to match an already-defined interface.

Do not initially give it ambiguous debugging or tasks requiring broad architectural inference. Its low price and non-reasoning instruct design are attractive, but the current independent coding evidence is less compelling than for GLM and DeepSeek.

### 4. Mercury 2.5: latency experiment only

Mercury belongs in the benchmark because a fast single-file worker could be useful even if it requires more orchestrator guidance.

Test it with:

- A precise target location.
- A narrow edit specification.
- Reasoning disabled or minimized.
- A strict test oracle.
- A small maximum diff.

Do not assume its advertised four-figure throughput produces faster completed tasks. Reasoning output and additional correction loops can erase the raw decode advantage.

### 5. Haiku 5.5: quality baseline

Haiku is not the cheapest option, but it provides an important comparison:

> Does the cheaper worker still win after failed patches, extra tests, orchestrator review, and escalation are included?

For single-file work, keep the prompt below Haiku’s 100K price cliff where practical. The orchestrator should supply relevant excerpts and dependencies rather than automatically sending an enormous repository context.

## Important exclusions and controls

### Laguna XS/S 2.1: promising, but leaving OpenRouter

Laguna XS 2.1 is attractively priced at **$0.06/$0.12**, with approximately **122 tok/s** observed throughput. See [Laguna XS provider endpoints](https://openrouter.ai/poolside/laguna-xs-2.1/endpoints).

Laguna S 2.1 has stronger published coding evidence. Poolside reports **70.2% on Terminal-Bench 2.1** with thinking enabled, compared with **60.4% without thinking**. See [Laguna 2.1 technical overview](https://poolside.ai/blog/laguna-2-1).

However, OpenRouter lists Laguna S 2.1 as **going away on October 31, 2026**, and the public API currently marks both XS and S with that expiration date. See [Laguna S on OpenRouter](https://openrouter.ai/poolside/laguna-s-2.1).

Therefore:

- Do not build a persistent OpenRouter routing policy around them now.
- Consider Laguna S separately only if direct Poolside API or self-hosting is acceptable.
- Avoid the free endpoint for proprietary code because its listed terms allow inputs and outputs to be used for training.

### Ling 3.1 Flash as the control worker

Ling 3.1 Flash itself is currently listed at **$0.075 input/$0.225 output**, with tool-capable Novita and DeepInfra endpoints.

That makes it price-competitive with several supposed cheap workers. A **Ling-primary + Ling-worker** arm would not test model diversification, but it would isolate the value of:

- Parallelism.
- Context isolation.
- Bounded task decomposition.
- Independent attempts.

Without this control, benefits from decomposition could mistakenly be attributed to the cheaper model.

## Illustrative cost comparison

Assume one bounded single-file task uses:

- **60K fresh input tokens** across its turns.
- **10K billed output tokens**, including reasoning.
- No caching, retries, or escalation.

| Candidate/route | Approximate model cost |
|---|---:|
| GLM 5.3 / OpenInference | **$0.00217** |
| Mercury 2.5 | **$0.00390** |
| DeepSeek V4 Flash / Baidu | **$0.00400** |
| GLM 5.3 / Wafer | **$0.00584** |
| Ling 3.1 worker control | **$0.00675** |
| Qwen3 Coder 30B / SiliconFlow | **$0.00700** |
| DeepSeek V4 Flash / Wafer | **$0.01010** |
| Haiku 5.5 | **$0.01100** |
| MiniMax M3.1 / InferenceNet | **$0.01150** |

Output cost matters more here than it did for scouts because coding workers produce patches, explanations, tool calls, and potentially substantial reasoning.

The real comparison must use **cost per accepted patch**, not this token-only estimate.

## Recommended worker contract

Each delegation should specify:

```text
Target file: exactly one writable file
Read-only dependencies: explicit files or search scope
Required behavior: bounded implementation instruction
Acceptance oracle: formatter, typecheck, and focused tests
Maximum tool calls
Maximum test/fix rounds
Maximum billed output tokens
Maximum diff size
Forbidden changes: tests, dependencies, configuration, additional files
Escalation condition: scope expansion or unresolved failure
```

The worker should:

1. Inspect the target and necessary dependencies.
2. Edit only the assigned file.
3. Run the specified formatter and focused tests.
4. Stop after the allotted repair rounds.
5. Return the diff, test evidence, remaining uncertainty, and any escalation reason.

The orchestrator retains responsibility for:

- Task decomposition.
- Protecting the tests and oracle.
- Reviewing the diff.
- Detecting scope creep.
- Running broader integration tests.
- Accepting or rejecting the patch.

Parallel workers are reasonable when they modify **disjoint files**. They should not independently modify shared interfaces or reconcile overlapping changes.

## Best first benchmark

Start with five arms:

1. **Ling 3.1 alone.**
2. **Ling 3.1 orchestrator + Ling 3.1 single-file worker.**
3. **Ling + GLM 5.3 Flash**, split into cheap and fast provider arms.
4. **Ling + DeepSeek V4 Flash 0731.**
5. **Ling + Haiku 5.5** as the quality baseline.

Add Qwen3 Coder for simple tasks and Mercury 2.5 for the latency arm.

Use localized tasks with known oracles:

- One-function bug fixes.
- Small feature additions.
- Type and lint repairs.
- Behavior-preserving refactors.
- Boundary-condition fixes.
- One-file test repairs where the test file itself is the assigned target.
- Tasks that secretly require a second file, to verify correct escalation.

Measure:

- Focused and integration test pass rates.
- Orchestrator patch-acceptance rate.
- Defects found during review.
- Unauthorized file modifications.
- Diff size and scope adherence.
- Tool-call and repair-round counts.
- Reasoning-token consumption.
- End-to-end latency.
- Escalation rate.
- **Total cost per accepted patch, including orchestrator review and retries.**

The expected starting policy is **GLM 5.3 Flash for ordinary bounded patches, DeepSeek V4 Flash as the cost/performance challenger, and Ling or Haiku for escalation**. This remains a hypothesis until the same single-file tasks are executed through the same harness.

## Evidence boundaries

- Prices, provider availability, throughput, and deprecations can change quickly.
- Coding and agentic indices are screening signals, not direct evidence of performance in this harness.
- Vendor benchmarks and third-party evaluations use different tasks, prompts, tools, and scoring rules.
- No paid provider calls or local coding benchmarks were performed for this report.
- The final adoption metric should be cost per accepted patch, with patch quality and scope adherence treated as hard constraints.
