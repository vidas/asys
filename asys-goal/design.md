# Goal loop design

Decision recorded 2026-09-21; review handoff revised 2026-09-25.

## Execution policy

Keep one implementation conversation across automatic work turns, using Pi's
normal compaction. Each successful implementation report must choose
`goal_status: "continue"` or `goal_status: "review"`. Continuing schedules another
work turn; requesting review launches a fresh verifier with tools. A work turn
may contain many edits, checks and corrections. It need not represent a fixed
sprint or a single checklist item.

The verifier receives the original request, governing sources, current
workspace, all prior reviews, human guidance and the implementer's latest
response. The response supplies repair evidence and rebuttals to investigate;
the reviewer independently checks those claims without inheriting the private
implementation conversation. Reviews return to the continuing implementer. Only
independent verification can complete the whole goal. Keep the user's request
authoritative rather than replacing it with a generated acceptance contract.
Planning remains part of ordinary implementation when useful.

Retain complete reviews as history. A review must reassess material earlier
concerns and explain repairs, remaining defects or mistaken objections against
the governing sources. Completion depends on the current assessment's coverage
and criteria. There is no persistent open/closed finding registry: labels cannot
create obligations or invalidate otherwise usable feedback. The controller
validates response structure, not the truth of an observation or requirement.
This trades mechanical record-closure checks for explicit semantic reassessment;
review quality must be evaluated on real tasks, including missed prior concerns.

An external committee's report belongs to the caller's task context. The goal
does not interpret that committee's labels or manage its approvals. After repair,
the caller can submit the workspace to the committee again.

This separates work continuity from review timing. A worker may make substantial
partial progress without starting another expensive review. Requesting review
is a handoff, not a declaration the controller accepts as success. The verifier
checks the actual work and the adequacy of its tests.

The existing JSON result protocol already provides a validated end-of-turn
control point. Adding `goal_status` there is sufficient; separate create,
update or complete-goal tools would duplicate controller state without a
current requirement for them. The caller owns goal creation and limits, and
the verifier owns acceptance.

An optional attempt limit counts successfully reported implementation turns,
including `continue` turns. Human retries and protocol corrections remain in
the current attempt. Durable controller state and the Pi transcript permit
recovery of the same job. A new goal invocation remains a new job, and no public
host resume command is implied.

## Evidence and its limits

[Codex's documented goal mode](https://learn.chatgpt.com/use-cases/follow-goals)
keeps a durable objective across turns toward a verifiable stopping condition.
In the [inspected runtime](https://github.com/openai/codex/blob/a86631502d49274cb47208925c7d3dcece032029/codex-rs/ext/goal/src/runtime.rs#L425),
an idle thread with an active goal receives another continuation turn. A separate
reviewer is not required at each turn boundary. Asys adopts automatic continuation
and deliberately retains independent artifact review at claimed completion.

[Claude Code's native goal feature](https://code.claude.com/docs/en/goal)
continues the same worker session and uses a separate fast evaluator when the
worker finishes a turn. Unmet verdicts return guidance to the worker. That
product evaluator judges the transcript without tools. Asys retains independent
artifact inspection, and makes costly review an explicit handoff rather than a
consequence of every partial-progress report. Product behavior establishes a
viable mechanism, not superiority.

[Anthropic's long-running application harness study](https://www.anthropic.com/engineering/harness-design-long-running-apps)
reports that Sonnet 4.5 benefited from context resets, while Opus 4.5 allowed
continuous sessions with compaction. With Opus 4.6, the author also removed
sprints and reviewed after substantial implementation runs. These are
model-dependent engineering observations, not a controlled comparison proving
one policy best. Its planner expanded sparse product ideas; that does not
establish a need to rewrite an already specified engineering request.

[Anthropic's context engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
describes compaction, persistent notes and focused subagents as complementary
options. This supports preserving scope and useful execution state while
limiting accumulated context; it does not rule out fresh-context handoffs.

[LoopsBench, Appendix N.3](https://arxiv.org/html/2608.00267v1)
explicitly cautions that its four native-goal/Ralph configurations are not a
model-controlled causal comparison. Their scores cannot rank session policies.
[Rethinking the Evaluation of Harness Evolution for Agents](https://arxiv.org/html/2607.12227v1)
finds that more elaborate harness optimization does not consistently beat
sequential refinement under matched budgets. It addresses a different comparison,
so it supports restraint without proving this design optimal.

## Validation

Controller and scripted-provider tests establish routing, isolation, persistence
and error handling. They do not establish better engineering output. Evaluate
quality on representative tasks with the same model, initial workspace, tools
and budget, repeated runs, behavioral checks and human code review. Compare
completion, regressions, wasted checks, time and cost. Change the default if
those results favor another policy; there is no claimed universal optimum.
