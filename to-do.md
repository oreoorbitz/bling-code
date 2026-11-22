# Bling Code local development to-do

Current local baseline: the focused learning/benchmark suites pass (132 tests across 6 files), and `npm run check` passes. These checks do not establish live model quality, effective-context performance, or cross-model superiority.

## 1. Establish the local development baseline

- [ ] Install Node.js 22.19 or newer.
- [ ] Run `npm ci --ignore-scripts`.
- [ ] Run `npm run build`.
- [ ] Run `npm run check` and compare the result with the current baseline.
- [ ] Run the focused learning suites before making further learning changes:

  ```bash
  node node_modules/vitest/vitest.mjs run \
    --config packages/coding-agent/vitest.config.ts \
    packages/coding-agent/test/learning-action-store.test.ts \
    packages/coding-agent/test/learning-benchmark.test.ts \
    packages/coding-agent/test/learning-memory-store.test.ts \
    packages/coding-agent/test/learning-improvement.test.ts \
    packages/coding-agent/test/learning-extension.test.ts \
    packages/coding-agent/test/learning-cli.test.ts
  ```

- [ ] Triage the dependency audit report previously observed during installation (2 moderate and 4 high vulnerabilities); update or replace affected dependencies where compatible, then rerun checks. Do not apply a force fix blindly.
- [ ] Triage and repair the stale `settings-manager.test.ts` fork fixtures.

## 2. Configure and smoke-test a real Ling endpoint

- [ ] Start a local vLLM or SGLang endpoint with the Ling reasoning and tool-call parsers required by the served model.
- [ ] Keep credentials in environment variables or external credential storage; never write real keys into the repository, prompts, benchmark definitions, or learning logs.
- [ ] Configure Ling 3.1 Flash explicitly with `bling configure --base-url ...`; do not rely on an implicit hosted provider.
- [ ] Run `bling doctor` and verify the exact served model ID, endpoint, dialect, context/output limits, and credential reference.
- [ ] Smoke-test ordinary responses, reasoning preservation, tool calls, session resume, and automatic compaction against the real endpoint.
- [ ] Separately configure and test Ling 3.0 Flash only when explicitly selected. Confirm there is no silent 3.0/3.1 substitution.
- [ ] Record endpoint/parser/version details with every live result so runs remain reproducible.

## 3. Validate project benchmarks locally

- [ ] Add project-specific executable oracles to `.bling/benchmarks.json` or through `bling benchmark add`.
- [ ] Keep benchmark environments isolated by default; use repeated `--allow-env NAME` only for required variables and `--inherit-env` only for trusted definitions.
- [ ] Add positive and negative validation controls to each important benchmark.
- [ ] Run `bling benchmark validate <name|id>` and reject vacuous oracles before using their results as evidence.
- [ ] Test timeout handling, output bounds, nonzero exits, required/forbidden output, and definition-file modification during execution.
- [ ] Confirm benchmark actions and integrity hashes appear in `.bling/learning/actions.jsonl` without credential values.
- [ ] Review benchmark commands as executable code. The current environment isolation is credential hygiene, not a kernel security sandbox.

## 4. Measure model and harness behavior before claiming improvements

- [ ] Define comparable, versioned benchmark suites for the project's actual coding tasks, including held-out cases.
- [ ] Predeclare model IDs, endpoints, decoding settings, prompts, harness versions, context limits, trial counts, timeouts, and acceptance predicates.
- [ ] Run repeated stochastic trials rather than relying on single runs; retain raw results and deterministic run IDs.
- [ ] Compare Ling 3.1 Flash with Ling 3.0 Flash and other explicit counterpoint models only under controlled, comparable conditions.
- [ ] Report pass rates, variance/confidence intervals, latency, token usage, cost, failures, and invalid/oracle-error rates where available.
- [ ] Separate harness changes from model changes; do not attribute an improvement to the model when prompts, tools, or retries also changed.
- [ ] Treat provider-returned reasoning as observational evidence, not causal ground truth.

## 5. Measure long-context and compaction behavior

- [ ] Build tasks with known evidence locations and answerable acceptance checks at several context lengths.
- [ ] Measure retrieval accuracy and task success before and after compaction, including adversarial distractors and conflicting instructions.
- [ ] Measure effective served context separately from the model's architectural maximum.
- [ ] Evaluate review-batch limits, memory/skill snapshot budgeting, compaction checkpoints, and resume behavior.
- [ ] Change defaults only when executed comparable runs support the change.

## 6. Calibrate optional Decider routing

- [ ] Enable Decider only explicitly; do not introduce implicit OpenRouter usage.
- [ ] Use `bling improve --decider-shadow` or `/improve decider-shadow` to collect gate decisions while still running Ling reviews.
- [ ] Label which batches genuinely benefit from generative review using executable or human-review evidence.
- [ ] Measure false accepts, false rejects, review utility, latency, and cost across candidate `thresholdChars` and `minProbability` values.
- [ ] Select thresholds from project-specific calibration data, then compare enforced mode against shadow/no-Decider baselines.
- [ ] Verify cache identities change when provider, model, prompt version, batch state, or thresholds change.

## 7. Review the self-improvement loop with real evidence

- [ ] Inspect assistant-to-tool `parentActionId` links on real sessions and repair orphaned or ambiguous traces if found.
- [ ] Confirm every generated proposal cites actions present in its batch and receives the correct ledger-derived evidence class.
- [ ] Test malformed, prompt-injected, unsupported, duplicate, stale-base, and over-budget proposals against faux providers before live use.
- [ ] Require explicit human approval for every memory or `.bling/skills` mutation; do not enable automatic background self-modification.
- [ ] Audit generated `MEMORY.md`, `proposals.json`, review cursors, replay deduplication, and crash recovery.
- [ ] Use benchmark evidence in improvement reviews, but require repeated comparable runs before accepting model-quality claims.

## 8. Remaining security and retention engineering

- [ ] Add an actually isolated execution mode for untrusted benchmarks using an OS/container sandbox with explicit filesystem, network, user, and resource policies.
- [ ] Add source-to-sink authorization for sensitive tools and review high-risk actions rather than relying only on output redaction.
- [ ] Evaluate externally anchored tamper-evident retention if audit integrity against a malicious local writer is required; locks and deterministic IDs alone do not provide it.
- [ ] Test redaction against additional provider-specific credential formats while treating it as lossy defense in depth.
- [ ] Verify file permissions, ignore rules, stale-lock recovery, concurrent writers, and behavior on the target local operating system.

## 9. Final release checks after local changes

- [ ] Run every new or modified focused Vitest file.
- [ ] Run `npm run check` and resolve all errors, warnings, and informational findings.
- [ ] Run broader tests and a production build explicitly when ready for release validation.
- [ ] Update `LING.md` and `packages/coding-agent/CHANGELOG.md` for user-visible changes.
- [ ] Inspect the final diff for secrets, unintended provider defaults, silent model fallback, generated artifacts, and unrelated changes.
- [ ] Record which acceptance clauses were executed and which remain waived or unmeasured.
