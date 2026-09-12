# Design and scope

SWE2 Bridge adds the installed Devin CLI as another worker capability in Codex's existing orchestration graph. Existing role, task, and model-selection rules remain authoritative. The bridge supplies run, wait, and cancel operations; Devin supplies the agent runtime.

```text
Codex orchestrator
  ├─ main task
  ├─ native agents
  └─ Devin MCP tools → local Devin CLI → selected Devin model
```

The Node MCP server uses stdio. It launches a local process with an explicit working directory and argument array, records job evidence, applies a deadline, and coordinates other bridge instances through checkout locks. The default model is `swe-2-medium`; callers can select another installed Devin model explicitly. The default Devin policy accepts file edits and respects workspace trust.

Jobs preserve evidence of the initial and final workspace, including dirty files, index entries, and committed Git trees. A successful process exit also requires a recognizable conversation export ending in an agent answer. Task acceptance remains the caller's decision. Ownership scope is an instruction to Devin, not an operating-system sandbox.

This is an experimental, locally installed project. macOS has real integration evidence; Linux remains unverified and Windows is unsupported. The public repository provides source, local installation, agent setup instructions, and a contribution path. It does not operate a hosted service or represent an official OpenAI or Cognition product.

See [local setup](docs/LOCAL_SETUP.md), [agent setup](docs/AGENT_SETUP.md), and [verification](VERIFICATION.md). Future contributions should address concrete observed behavior: additional platforms, permission-gated workflows, abrupt interruption recovery, and substantial engineering tasks. Multiple simultaneous jobs per bridge instance, automatic replay or model fallback, and a native Codex model-picker entry are outside the current scope.
