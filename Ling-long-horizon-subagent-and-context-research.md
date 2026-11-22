# Ling Long-Horizon Subagent and Context-Management Research

**Date:** October 25, 2026  
**Scope:** Affordable subagent orchestration, cost and latency trade-offs, context rot, compaction, auto-compaction, and external state for the Ling/Pi coding harness.

## Executive conclusion

Pairing Ling 3.1 Flash with cheaper agents is worth testing, but not as a committee of equals. The most promising architecture is:

- **Ling remains the planner, integrator, and primary writer.**
- **Cheap agents handle bounded, independent, read-heavy work:** repository search, documentation extraction, log triage, test classification, and narrowly scoped reviews.
- **Ling validates and integrates their outputs.**
- **Every delegation has a budget and an acceptance oracle.**
- **Escalation is centralized:** subagents do not independently retry, spawn more agents, or switch models.

The likely benefits are lower primary-context pressure and shorter wall-clock time on parallelizable work. Lower total cost is possible, but not automatic. Multi-agent systems can consume substantially more tokens, and coding work with tightly coupled decisions often benefits more from one coherent agent than from several writers. Anthropic reports approximately 15 times greater token consumption for its multi-agent research architecture relative to ordinary chats, while a multi-agent SWE study found highly workload-dependent gains alongside increased costs. See [Anthropic’s multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) and the multi-agent SWE findings discussed below.

For long-horizon reliability, the strongest combined strategy is:

> **Pin critical state, compact at meaningful milestones, externalize large observations, and reconstruct context from ground truth rather than trusting an increasingly long conversation.**

## 1. What should—and should not—be delegated

### Good delegation candidates

| Work | Why it fits |
|---|---|
| Repository search and call-graph discovery | Independent, read-only, and easy to check against paths and line ranges |
| Documentation extraction | Narrow objective with a small structured result |
| Log triage and failure clustering | Keeps large logs out of Ling’s active context |
| Test execution and result classification | A deterministic oracle is available |
| Independent review of a completed patch | The diff is bounded and findings can be verified |
| Finding evidence for or against a hypothesis | Provides a second perspective without transferring control |
| Migration inventory | Repeated extraction across many files |
| Large-output reduction | Raw output stays on disk while Ling receives references and selected excerpts |

### Work to keep with Ling initially

- Architectural decisions.
- Cross-cutting implementation plans.
- Final patch integration.
- Coupled edits spanning several modules.
- Security-sensitive authorization decisions.
- Memory or skill-change proposals.
- Ambiguous debugging where the hypothesis is still changing.
- Final acceptance when no executable oracle exists.

Cognition’s critique of multi-agent coding is directly relevant: parallel workers making local decisions can produce changes that are individually plausible but collectively incoherent. Its context-engineering discussion argues that agents need sufficiently shared context when their decisions depend on one another. See [Don’t Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents).

### Recommended delegation contract

Every subagent request should include:

```text
Objective
Allowed paths and tools
Read-only or write scope
Relevant files / observation references
Required output schema
Token, time, and tool-call budgets
Acceptance oracle
Explicit escalation condition
```

Results should return evidence, not just prose:

- Paths and line ranges.
- Commands executed.
- Test results.
- Observation IDs and hashes.
- Confidence and unresolved uncertainty.
- A suggested next action, without silently performing it.

The existing Pi subagent extension already provides separate subprocesses, isolated contexts, explicit per-agent model selection, parallel execution, abort propagation, and usage reporting. That is the right mechanism to extend; another agent framework would add unnecessary coordination complexity.

A separately selectable earlier Ling generation may be evaluated for bounded internal roles, but it must always be an explicitly named role configuration. It must never become an implicit fallback or silent substitution for Ling 3.1.

## 2. Where pairing can help—and where it can hurt

### Likely wall-clock improvements

Parallelism helps when tasks are genuinely independent:

```text
Ling: inspect architecture and formulate plan
 ├─ Scout A: trace frontend data flow
 ├─ Scout B: trace backend API path
 └─ Scout C: inspect tests and previous failures
Ling: reconcile evidence and implement
```

Here, the scouts replace serial reading and reduce the amount of raw material entering Ling’s context.

Parallelism is much less useful when one task depends on another’s result, or when every worker needs the same large repository briefing. In those cases, spawn overhead and repeated context can outweigh concurrent execution.

### Likely cost improvements

Cost falls only when delegation replaces work that Ling would otherwise perform, rather than adding another complete investigation.

The correct measure is:

```text
cost-of-pass =
    (Ling cost + subagent cost + spawn/retry/escalation cost)
    / tasks passing the oracle
```

A configuration with cheaper tokens but more failed tasks can be more expensive overall. Wall-clock time, token cost, and total compute should therefore be reported separately.

### Negative effects to guard against

- Every subagent receives a large duplicate prompt.
- Ling reads both the raw material and the subagent’s summary.
- Agents repeat searches Ling already performed.
- Failed cheap agents trigger multiple paid retries.
- Reviewers produce speculative findings that Ling must disprove.
- Several workers edit overlapping files.
- Subagents hide failures behind confident summaries.
- Parallel API calls overload the endpoint and increase queueing.
- Different models produce incompatible assumptions or styles.

Anthropic reports strong results from parallel multi-agent research, but that pattern fits independent, read-heavy work rather than tightly coupled implementation. Its reported research gains should not be transferred to coding without a local head-to-head comparison. The same report also emphasizes the substantial token overhead of multi-agent execution. See [Building a multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

A multi-agent SWE study found a mean improvement of approximately 9%, with a range from negative to substantially positive outcomes across workloads, while mean costs increased by approximately 15.9%. This supports treating delegation as a workload-specific hypothesis rather than a universal optimization.

**Recommendation:** start with read-only scouts and verifiable reviewers. Do not begin with parallel autonomous coders, subagent debate, majority voting, uncontrolled fan-out, or independent retry loops.

### Recommended routing policy

1. Run deterministic tools first when they can answer the question without a model.
2. Delegate independent read-heavy exploration to a bounded scout.
3. Keep planning and reconciliation with Ling.
4. Delegate implementation only when the scope is isolated and an executable oracle exists.
5. Use a single writer for coupled changes.
6. Require Ling to perform final integration and acceptance.
7. Centralize retries and escalations, with explicit budgets.

## 3. Context rot: what the evidence implies

Long context is capacity, not guaranteed reliable attention.

Recurring failure modes include:

- **Lost in the middle:** relevant information is used less reliably depending on its position.
- **Distraction:** historical tool output and abandoned approaches crowd out current evidence.
- **Poisoning:** an earlier incorrect claim continues influencing later decisions.
- **Confusion:** irrelevant tools, memories, or instructions change behavior.
- **Clash:** contradictory accumulated state leaves no clear source of truth.
- **Goal drift:** the current objective gradually diverges from the original request.

The context-rot literature describes these as related but distinct problems rather than one simple “window too full” failure. Relevant research includes *Context Rot: How Increasing Input Tokens Impacts LLM Performance* and [*Lost in the Middle: How Language Models Use Long Contexts*](https://arxiv.org/abs/2307.03172).

Multi-turn degradation is especially relevant to coding. An early wrong turn can remain in the trajectory and influence later turns even after contrary evidence appears. Appending corrections does not necessarily neutralize the earlier trajectory; sometimes the safer operation is to archive that branch and restart from a clean checkpoint.

### Practical mitigations

#### 1. Keep critical instructions verbatim and pinned

Pin the following outside ordinary compaction:

- Original task.
- User constraints.
- Security rules.
- Explicit model and endpoint policy.
- Current acceptance criteria.

#### 2. Separate working state from narrative history

Maintain a structured record of:

- Current plan.
- Completed steps.
- Files changed.
- Tests run and results.
- Failed hypotheses.
- Next action.

#### 3. Remove abandoned branches aggressively

Do not preserve every correction in the active prompt. Archive the old trajectory and restart from a clean, verified state when an abandoned branch is actively confusing the run.

#### 4. Re-read ground truth at decision points

Check:

- Current file contents.
- Current diff.
- Current test output.
- Actual endpoint and model configuration.

#### 5. Use subagents as context isolation

Give each scout only the relevant slice. Return compact evidence rather than copying entire transcripts into Ling’s context.

#### 6. Keep stable prompt prefixes

Stable system instructions, policies, and approved memory improve cache reuse. Put volatile timestamps, transient diagnostics, and changing working state later in the prompt.

Anthropic’s context-engineering guidance similarly emphasizes finding the smallest useful set of high-signal tokens rather than treating the full window as free capacity. See [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

## 4. Compaction and auto-compaction

### Main finding

**Compaction is a state-transition operation, not merely a request to “summarize the conversation.”**

A summary optimized for readability can still be a poor agent checkpoint. It may omit:

- A constraint stated many turns earlier.
- The current plan step.
- An unresolved test failure.
- Approaches already ruled out.
- The exact next tool action.
- Which files were modified versus merely inspected.

The current Pi implementation already has manual, threshold, and overflow compaction paths, iterative summary updating, split-turn summaries, and tracked file operations. These are useful foundations. The recommended changes should therefore be evaluated as extensions and shadow-mode alternatives, not as an untested replacement.

### Recommended context layout after compaction

1. Verbatim system instructions and user constraints.
2. Approved project memory.
3. Structured working-state snapshot.
4. Current plan and next action.
5. Recent verbatim turns.
6. Restorable references to older observations and ledger records.

### Required working-state schema

```text
Task and acceptance criteria
Established findings
Current plan and completed steps
Files read / modified / currently dirty
Commands and tests executed
Current failures and failing oracles
Ruled-out approaches
Unresolved questions
Immediate next action
Source session leaf and ledger-action ranges
Relevant commit SHAs and observation hashes
```

### Trigger policy

Use proactive stage-boundary compaction plus a token-threshold fallback:

- After exploration, before implementation.
- After implementation, before verification.
- After a failing approach is abandoned.
- Before a long test or migration phase.
- After unusually large tool output.
- When repeated loops indicate a poisoned trajectory.
- At the existing overflow or threshold path as a safety net.

Avoid compacting in the middle of an unresolved tool-call sequence or atomic side-effect group.

Recent AutoCompact research supports task-progress-aware compaction over purely length-triggered compaction. It reports proactive compaction based on task progress outperforming fixed-length compaction and full-history baselines in its evaluated settings. This remains a research result to replicate, not a guarantee for this harness. Fixed-threshold compaction can also underperform no compaction when it discards decision-critical state at the wrong time.

### Restorable compression

Large observations should be replaced with references such as:

```json
{
  "type": "observation-ref",
  "path": ".ling/observations/obs_example.txt",
  "sha256": "…",
  "bytes": 183420,
  "sourceActionId": "act_…",
  "description": "Full integration-test output",
  "importantRanges": [[1240, 1315]]
}
```

This is preferable to an irreversible summary when the original output may be needed again. Observation-masking experiments in SWE-agent settings found that replacing old observations can be competitive with summarization while reducing cost. The important distinction is that the raw observation remains recoverable.

### Resume validation

Before continuing after compaction, verify:

- The next action still follows from the plan.
- No pinned constraint disappeared.
- Current file and test state match the summary.
- Failed approaches remain marked as failed.
- Referenced files and observations still exist and match their hashes.

If critical state is missing, repair it from the session or ledger, or stop for review. Do not let the model improvise the missing state.

## 5. External-state architecture for the Pi fork

The fork already has two valuable foundations:

- Pi’s append-only JSONL sessions and compaction entries.
- `.ling/learning/actions.jsonl` with deterministic action, tool, run, benchmark, review, and proposal IDs.

The recommended design adds three layers rather than another memory system.

### A. Observation store

Proposed location:

```text
.ling/observations/
```

Store large tool outputs, test logs, generated diffs, and documentation extracts. Context contains hashes, paths, byte ranges, and provenance—not the entire payload.

### B. Named checkpoints

Proposed record contents:

```text
Checkpoint ID
Session ID and leaf ID
Git HEAD and dirty-file manifest
Current working-state snapshot
Todo/plan snapshot
Approved memory version
Open failures and pending side effects
Next action
Source action-ID range
```

Checkpoints make “resume from before this wrong turn” a deterministic operation instead of another prompt-engineering trick.

### C. Provenance-linked compaction records

Each compaction should identify:

- Original session leaf.
- Action range covered.
- Summary version.
- Working-state version.
- Observation references.
- Compaction model and endpoint.
- Validation result.

This allows later evaluation of whether a failure came from the model, the summary, missing state, or the environment.

### Replay and idempotency

External state supports replay, but replay must not blindly repeat side effects. Network requests, writes, deployments, payments, and similar operations need idempotency keys, recorded outcomes, or current-state checks before re-execution.

A resumed run should be able to distinguish:

- An action that was requested but never executed.
- An action whose result was recorded successfully.
- An action whose completion is uncertain.
- An action that must not be repeated automatically.

### Security boundaries

- Append-only JSONL is not automatically tamper-evident.
- External observations remain untrusted input when reloaded.
- Persistent memory and compaction are prompt-injection and write channels.
- Unapproved semantic or procedural memories should remain quarantined.
- Replay must not blindly repeat network requests, writes, payments, or other side effects.
- Human approval should remain mandatory for memory and skill changes.

Manus’s production guidance similarly emphasizes filesystem-backed state and restorable compression. See [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus).

## 6. Prioritized local benchmark plan

No Ling-specific quality, speed, compaction, or routing claim should be adopted without comparable executed runs. Vendor benchmarks from different harnesses are not direct head-to-head evidence.

### Experiment 1: Does cheap delegation actually help?

**Arms**

1. Ling 3.1 only.
2. Ling plus a low-cost extraction scout.
3. Ling plus an affordable tool-using worker.
4. Ling plus an independent bounded reviewer.
5. Ling plus multiple parallel read-only scouts.

Keep prompts, tools, repository snapshot, task budget, and acceptance tests fixed. Repeat runs rather than relying on one trajectory.

**Task classes**

- Independent repository exploration.
- Large-log diagnosis.
- Cross-module implementation.
- Coupled debugging.
- Patch review.
- Long documentation extraction.

**Primary outcomes**

- Oracle pass rate.
- Cost-of-pass.
- p50 and p95 wall-clock time.
- Total tokens by role.
- Retry and escalation counts.
- Primary-context tokens saved.
- Incorrect or unverifiable subagent claims.
- Cache-read and cache-write volume.

Pre-register adoption criteria before running the comparison. For example, require either lower cost-of-pass without an unacceptable success-rate reduction, or materially lower wall-clock time within a specified cost and quality margin.

### Experiment 2: Compaction strategy

**Arms**

1. Full history where feasible.
2. Current threshold compaction.
3. Milestone compaction.
4. Milestone compaction plus pinned working state.
5. Observation references plus milestone compaction.

**Metrics**

- Constraint survival.
- Plan retention.
- Next-action correctness.
- Repeated commands and searches.
- Forgotten failing tests.
- Goal drift.
- Cost-of-pass.
- Cache-hit rate.
- Resume latency.

### Experiment 3: Checkpoint and resume fidelity

Inject termination:

- During exploration.
- After a partial patch.
- Immediately after a tool side effect.
- Following compaction.
- During parallel subagent execution.

Measure whether the resumed run preserves the diff, avoids duplicate side effects, resumes the correct plan step, and reaches the same oracle.

### Experiment 4: Cache-aware rendering

Test stable-prefix rendering against frequently changing prompt prefixes. Track cache reads and writes separately from logical token counts. A low-token design can still be expensive if it destroys prefix reuse.

## 7. Recommended implementation order

1. **Add per-role accounting** to the existing subagent path: primary, scout, reviewer, retry, escalation, and cache tokens.
2. **Introduce explicit role configurations** with no automatic model or provider fallback.
3. **Implement observation references and named checkpoints.**
4. **Add structured working state and pinned constraints.**
5. **Run milestone compaction in shadow mode**, comparing its state against the existing compactor before enabling it by default.
6. **Benchmark read-only delegation first.**
7. Only then test bounded coding workers or more aggressive auto-compaction.

The cleanest first architecture is:

> **Ling 3.1 primary, bounded read-only scouts, Ling-only integration and final acceptance, centralized retries, structured checkpoints, and milestone-based compaction.**

This tests the central hypothesis without confounding it with parallel writers, uncontrolled fan-out, or automatic generation switching.

## Evidence boundaries

- The architectural recommendations are syntheses of published research, production reports, and inspection of the current harness.
- Published multi-agent gains are workload-dependent and often come from research or retrieval tasks rather than coupled coding.
- Compaction results from research systems require replication against this harness’s sessions, tools, and workloads.
- No live Ling-primary/cheap-subagent head-to-head has yet been executed for this project.
- Cost, speed, and quality claims should therefore remain hypotheses until the local benchmark plan produces comparable executed evidence.
