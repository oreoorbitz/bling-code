# Fast, Affordable Scout Models on OpenRouter

**Research date:** October 25, 2026  
**Workload:** Orchestrator-directed scouts that use tools or scripts to search for specific patterns, read entire files, and return concise summaries. Scouts do not develop complex plans or make code changes.

## Best scout candidates on OpenRouter

OpenRouter’s public model and endpoint metadata was filtered for **tool-capable models with at least 32K context and comparatively low output prices**. Provider-level pricing and recent throughput figures were then compared.

**Initial shortlist: Ling 3.0 Flash, GPT-OSS 20B, and Mercury 2.5.** Add DeepSeek V4 Flash for very large files and GLM 5.3 Flash as a higher-fidelity comparison.

Prices below are per million tokens. Throughput is a recent OpenRouter observation, not a guarantee; provider performance changes with load.

| Candidate and route | Input / output | Context | Recent speed | Fit for the scout role |
|---|---:|---:|---:|---|
| **Ling 3.0 Flash — Novita** | **$0.021 / $0.063** | 262K | Roughly **134–151 tok/s** | **Best default candidate:** extremely cheap, fast enough, and from the same model family as the primary. [OpenRouter pricing and p50 comparison](https://openrouter.ai/compare/inclusionai/ling-3.0-flash/nvidia/nemotron-3-ultra) |
| **GPT-OSS 20B — CoreWeave or Groq** | CoreWeave **$0.030 / $0.130**; Groq **$0.075 / $0.300** | 131K | Approximately **111–145 tok/s** on cheaper CoreWeave; up to approximately **417 tok/s** on faster routes | **Best raw-speed candidate** for tightly structured search and extraction. [OpenRouter provider endpoints](https://openrouter.ai/openai/gpt-oss-20b/endpoints) |
| **Mercury 2.5 — Inception** | **$0.040 / $0.150**, currently marked 80% off | 260K | OpenRouter p50 approximately **168 tok/s**; vendor advertises 1,107 tok/s | **Most interesting latency experiment:** parallel tools and schema-aligned JSON, but reasoning must be tightly controlled. [Model listing](https://openrouter.ai/inception/mercury-2.5) and [observed p50 comparison](https://openrouter.ai/compare/inception/mercury-2.5/openai/gpt-6-luna-pro/openai/gpt-6-luna/anthropic/claude-haiku-5.5) |
| **DeepSeek V4 Flash 0731 — low-cost providers** | From approximately **$0.044 / $0.133** | 1M | Approximately **78 tok/s** model-wide p50; some providers have historically exceeded 130 tok/s | **Best inexpensive long-file reader:** attractive when 262K is insufficient. [Price overview](https://www.requesty.ai/models/deepseek/deepseek-v4-flash-0731) and [OpenRouter p50 comparison](https://openrouter.ai/compare/deepseek/deepseek-v4-flash-0731/google/gemini-3.1-flash-lite/z-ai/glm-5.3-flash) |
| **GLM 5.3 Flash — Wafer** | Approximately **$0.064 / $0.200** | 1M | Wafer around **145 tok/s**; fastest providers around 150 tok/s | **Best quality-leaning scout candidate:** inexpensive enough for delegation, with plenty of provider choices. [OpenRouter provider endpoints](https://openrouter.ai/z-ai/glm-5.3-flash/endpoints) |
| **Qwen3.7 Flash — Alibaba** | **$0.03 / $0.13 only below 32K**; at 32K–256K it becomes **$0.10 / $0.40** | 1M | Approximately **62 tok/s**, 0.70 s latency | Useful for multimodal scouting, but **not a speed leader**, and entire-file tasks often leave its cheapest price band. [Price-band overview](https://www.oflight.co.jp/en/columns/qwen3-7-flash-api-pricing-vision-2026) and [OpenRouter provider comparison](https://openrouter.ai/compare/qwen/qwen3.7-flash/openai/gpt-5-nano/inception/mercury-2) |

## Practical ranking

1. **Ling 3.0 Flash:** first default to test.
2. **GPT-OSS 20B:** first speed challenger.
3. **Mercury 2.5:** first new-architecture and latency challenger.
4. **GLM 5.3 Flash:** fidelity baseline if the cheaper scouts miss important details.
5. **DeepSeek V4 Flash 0731:** long-context specialist.
6. **Qwen3.7 Flash:** small-context or multimodal specialist rather than default text scout.

Using Ling 3.0 here would be an **explicit, separately configured scout role**, never a fallback for Ling 3.1.

## Output price is not the whole cost for this workload

A scout reading entire files is usually **input-heavy and output-light**.

For an illustrative task with:

- 100K fresh input tokens;
- 2K visible summary tokens;
- no reasoning tokens, caching, retries, or additional tool results;

the approximate model charges are:

| Candidate/route | Cost per scout task |
|---|---:|
| Ling 3.0 on Novita | **$0.00223** |
| GPT-OSS 20B on CoreWeave | **$0.00326** |
| Mercury 2.5 | **$0.00430** |
| DeepSeek V4 Flash 0731 | **$0.00471** |
| GLM 5.3 Flash on Wafer | **$0.00680** |
| Qwen3.7 Flash at its 32K–256K band | **$0.01080** |

The important optimization is therefore not simply finding the cheapest output token:

> **Minimize repeated file input, suppress unnecessary reasoning, and return short evidence-linked summaries.**

Reasoning tokens are especially important. Mercury’s advertised four-figure throughput does not automatically translate into faster tasks. One small independent OpenRouter experiment observed 90% of Mercury’s output going to reasoning, with little end-to-end improvement despite much higher raw throughput. See [Mercury 2.5 vs GPT-6 Luna on OpenRouter](https://dev.to/alex_p_c604a392739082cd/mercury-25-vs-gpt-6-luna-on-openrouter-speed-reasoning-and-the-new-cheap-tier-2p56).

For scouts, start with **reasoning disabled or the lowest supported effort**, then escalate only if extraction quality is inadequate. Excluding reasoning from the response does not avoid its cost; it must actually be disabled or reduced. See [OpenRouter’s reasoning-token guidance](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## Recommended routing configuration

For predictable cost and reproducible benchmarks, pin both the model and provider:

```json
{
  "model": "inclusionai/ling-3.0-flash",
  "provider": {
    "order": ["novita"],
    "allow_fallbacks": false,
    "require_parameters": true
  },
  "reasoning": {
    "enabled": false
  }
}
```

Use the equivalent explicit provider for each candidate. `require_parameters` prevents routing to an endpoint that does not support the requested tools or response format; disabling fallbacks prevents an unexpected provider—or price—from being substituted. See [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

Also recommended:

- Pin concrete model slugs rather than `~latest` aliases.
- Avoid automatic `:nitro` routing during price comparisons because it can select a more expensive endpoint.
- Set `data_collection: "deny"` or `zdr: true` where project privacy requires it.
- Record the actual returned provider, model, reasoning tokens, cached tokens, latency, and price in the action ledger.

## Best first experiment

Use three initial scout configurations:

1. **Ling 3.0 / Novita:** low-cost default.
2. **GPT-OSS 20B / CoreWeave:** low-cost speed arm, with **Groq** as the explicit higher-speed arm.
3. **Mercury 2.5 / Inception:** low reasoning or reasoning disabled.

Add **GLM 5.3 / Wafer** as the fidelity baseline and **DeepSeek V4 Flash** for files exceeding the other models’ comfortable context.

Measure them on deterministic scout tasks:

- Find definitions and references for a symbol.
- Locate code matching specified patterns.
- Read several files and return a structured architectural summary.
- Trace a value through a known call path.
- Summarize a test failure with exact file and line references.

The key metrics should be:

- Time to first tool call.
- End-to-end task latency.
- Valid tool-call rate.
- Search precision and recall.
- Unsupported summary claims.
- Reasoning-token overhead.
- Cost per accepted scout result.

Raw output tokens per second alone will not identify the best scout.

## Evidence boundaries

- Prices and provider availability can change quickly; confirm them before a paid run.
- Throughput figures are recent observations or vendor statements, not guaranteed sustained performance.
- Tool support can vary by provider even for the same model.
- These are candidates for local evaluation, not measured quality winners for this project.
- No paid provider calls or model-quality benchmarks were performed for this report.
