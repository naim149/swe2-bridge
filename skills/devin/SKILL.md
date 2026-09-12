---
name: devin
description: Delegate an engineering task to the installed Devin CLI, then collect or cancel its result. Use when the user's existing orchestration rules or explicit request select a Devin worker.
---

# Devin CLI

Devin is an available worker runtime alongside the native agents. Apply the user's existing task, role, and model-selection rules. This capability adds no selection priority or new routing policy.

## Delegate

Call `devin_run` with the task, absolute `cwd`, and the selected `model` when specified. Give the worker the objective, relevant files, constraints, acceptance criteria, and expected output. Use `scope` to communicate file ownership and allowed work. These instructions describe the assignment; they do not enforce filesystem isolation.

Coordinate file ownership with other agents before starting work. The bridge's checkout lock covers bridge jobs only. Native agents can still edit that checkout. Preserve existing work and give independent agents disjoint ownership.

Keep the returned `job_id`. Call `devin_wait` with that ID and a `wait_seconds` value of at most 30 to collect progress or the final result. Continue independent work between waits. Use `devin_cancel` when the assigned work should stop.

## Interpret the result

Process completion means the worker finished its invocation. Check its answer, changed files, and verification evidence against the task's acceptance criteria before accepting the work. Follow artifact paths when additional context is needed.

An authentication, unavailable-model, workspace-trust, or permission failure needs its reported cause addressed. Do not silently substitute a model, retry a potentially mutating task, or change Devin permissions. If interrupted, inspect the existing result and files before submitting another job.
