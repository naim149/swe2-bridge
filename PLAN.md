# Design and scope

SWE2 Bridge adds the installed Devin CLI as another worker capability in Codex's existing orchestration graph. Existing role, task, and model-selection rules remain authoritative. Version 0.2 supplies durable assignment sessions, bounded progress collection, follow-ups, permissions/questions, and verification evidence. Devin supplies the agent runtime.

```text
Codex orchestrator
  ├─ main task
  ├─ native agents
  └─ Devin MCP tools → local ACP session → exact selected SWE-2 model
```

The Node MCP server uses stdio. Its session manager persists assignment identity before inference, starts or resumes an ACP session, collects bounded events, applies a deadline, and coordinates bridge instances through checkout/resource locks and a shared external pool of up to three. The Lead also counts native and external workers under the caller's existing budget.

The only accepted model IDs are `swe-2-medium`, `swe-2-high`, and `swe-2-max`; there is no alias or silent fallback. Assignment profiles are `read`, `edit`, and `edit_check`. Delegated writes are checked against explicit owned paths, and client terminal handlers enforce declared check commands and actual working directories. Trust is inherited from an exact native directory record or explicitly acknowledged by the caller for the assignment. These controls are not an OS sandbox and do not cover all built-in CLI tools.

Repeating an assignment ID/revision with identical intent returns its recorded job instead of replaying a prompt. A deliberate follow-up uses the next revision and returns a new job ID in the same Devin session. Interrupted or incomplete work requires the caller to inspect and acknowledge partial changes. Permission and bounded form questions use explicit responses; undeclared commands need an amended assignment or native handoff.

Results distinguish model completion, observed scope changes, check evidence, missing information, and task acceptance. Git worktree/index/HEAD evidence has known gaps, and event/output limits are reported. Native check evidence is caller-reported rather than independently executed by the bridge. `task_accepted` remains false for the caller to decide.

This is an experimental, locally installed project. macOS has real integration evidence; Linux remains unverified and Windows is unsupported. The public repository provides source, local installation, agent setup instructions, and a contribution path. It does not operate a hosted service or represent an official OpenAI or Cognition product.

See [local setup](docs/LOCAL_SETUP.md), [agent setup](docs/AGENT_SETUP.md), the [worker contract](docs/WORKER_CONTRACT.md), and [verification](VERIFICATION.md). Source/regression checks complement the recorded real disposable-workspace trials. An OS sandbox, automatic replay/model fallback, remote hosting, and native Codex model-picker integration remain outside this version's scope.
