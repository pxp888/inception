# inception

A [pi](https://github.com/badlogic/pi-mono) coding agent extension that replaces the standard
compaction routine with a **Context Gardener**: a second LLM that curates (trims/summarizes)
the primary agent's context so it can work without accumulating unnecessary information.

Every N turns, everything older than a protected head of recent turns is handed to the curator
model, which rewrites it into a compact factual replacement — e.g. a full file read becomes
"checked file A: contains only X". The newest N turns are always kept verbatim. The curator
never performs the objective or writes code; its output replaces old history in context.

## Why use inception?

In long coding and chat sessions, context quickly accumulates noise:

- Multi-page tool outputs, file dumps, and build logs.
- Failed search attempts and discarded exploration paths.
- Boilerplate code that can easily be regenerated.exit

Standard compaction routines ask an agent to summarize a nearly full context window in one pass.  This is challenging because the compacting agent needs to figure out what is important over a very full context window, and has only one chance to do so.  



This extension replaces the standard compaction routine with one that runs every three turns, so the 'curating' agent can concentrate on maintaining important information and discarding or summarizing information with a reasonable context.  

The resulting context left for the 'main' agent is kept as short as it must be, and is _informationally dense._



[Initial test results](https://github.com/pxp888/memento/blob/main/testing.md)



### Curating agent prompt:

> You are the Context Gardener for a coding agent. Your responsibility is to reduce the agent's conversation context while preserving everything necessary to continue its current objective correctly.
> 
> Review the eligible historical conversation and produce a concise replacement that allows the main agent to resume work without repeating investigations, losing important discoveries, or undoing successful changes.
> 
> Prioritize preserving:
> 
> 1. The current objective, requirements, acceptance criteria, and constraints.
> 2. Current implementation state, including relevant files, functions, nterfaces,
>    and successful changes.
> 3. Important discoveries, including failed searches, negative findings,
>    environmental limitations, and rejected approaches.
> 4. Decisions already made and their rationale.
> 5. Outstanding work, unresolved questions, blockers, and the next useful steps.
> 6. Relevant user instructions and preferences.
> 
> Remove verbose tool outputs, irrelevant exploration, redundant explanations,
> superseded plans, and boilerplate that can safely be regenerated.
> 
> Do not treat a failed investigation as worthless. Preserve its conclusion whenever it prevents repeated work or constrains future decisions. Prefer a short factual statement over a transcript of the investigation.
> 
> Do not invent facts, infer that an operation succeeded when only an attempt is
> recorded, or claim that files contain particular code unless the available context supports that claim.
> 
> The newest protected turns are outside your editing scope. Preserve their contents exactly.
> 
> Produce a compact, factual context replacement. Optimize for the main agent's ability to continue working, not for a comprehensive historical narrative. When uncertain whether information is essential, preserve it in a concise form rather than deleting it.
> 
> Operational rules:
> 
> - Keep your internal reasoning/thinking concise. Do not overthink; proceed directly
>   to extracting and updating the state.
> - Your replacement will be shown to the main agent as its session state, in place of
>   the summarized history.
> - Output only the replacement context: no preamble, no closing remarks, no markdown code fences.



## Install & usage

The extension is two files (`index.ts` imports `./boundary.ts`) — always copy both. Pick **one** install location per machine; installing in more than one makes pi reject the duplicate `--inception-*` flags:

- Global (all projects): `mkdir -p ~/.pi/agent/extensions/inception && cp index.ts boundary.ts ~/.pi/agent/extensions/inception/`
- Per-project: copy both files into `<project>/.pi/extensions/inception/`
- No install at all: `pi --extension /path/to/inception/index.ts` (use this while developing)

```sh
pi --extension /path/to/inception/index.ts
```

Flags (all optional):

| Flag                         | Default               | Meaning                                                                                              |
| ---------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| `--inception-frequency`      | `3`                   | Run curation every N turns. Each model call counts as a turn, tool calls included (pi's `turn_end`). |
| `--inception-protected-head` | `5`                   | Keep the newest N turns untouched; only older history is curated.                                    |
| `--inception-model`          | current session model | Curator model as `provider/modelId`, e.g. `google/gemini-2.5-flash` for cheap curation.              |

## How it works

- **Scheduled curation** — on each `turn_end` the extension counts turns since the last
  curation. When the frequency is reached and there is history outside the protected head,
  it calls the curator model (the run pauses briefly) and commits a compaction entry from
  the turn boundary. The agent then resumes with `[curated state] + [protected head]` as its
  context. pi's manual `ctx.compact()` is deliberately not used because it aborts the current
  run first; committing at the `turn_end` boundary keeps in-flight runs alive.
- **Standard compaction replaced** — pi's own threshold/overflow compactions and `/compact`
  are intercepted via `session_before_compact` and curated the same way (protected head +
  curator prompt), which also covers long single-prompt agentic loops that outgrow the context
  window mid-run. If curation fails or returns nothing, pi's default routine runs instead.
- **Iterative** — each pass receives the previous curated state as input and must carry
  forward anything still relevant, so discoveries survive repeated compactions.

Notes:

- The protected head is a soft guarantee: under hard context pressure (threshold/overflow),
  letting pi's default cut run is safer than overflowing, so the head may yield in that case.
- Curator calls disable prompt-cache writes and use a fresh session id (one-off prompts).

## Development

```sh
npm install        # dev deps: pi-coding-agent + typescript for typechecking
npm test           # node --test test.ts  (pure boundary logic, no LLM needed)
npx tsc --noEmit --strict --skipLibCheck --target es2022 --module nodenext \
    --moduleResolution nodenext --allowImportingTsExtensions index.ts test.ts boundary.ts
```

Files: `index.ts` (extension), `boundary.ts` (pure turn-boundary math, dependency-free),
`test.ts` (unit tests for the boundary logic).
