# inception 

The goal of this project is to allow an agent to work without accumulating a context full of unnecessary information.  

This is accomplished by using a custom compaction routine that calls a second agent to curate, or trim the context of the primary agent.  

This trimming should use the standard edit tools to remove or summarize information that is not needed for the primary agent's current objective.  

For example, if you are looking for something and read file A, normally the contents of that file would remain in context.  Here the curator could replace that with a note saying 'checked file A, it only contains ....'.  

The curator should NOT perform the objective directly, or generate code.  It should only curate information for the primary agent.  


## implementation 

This should be implemented as a pi coding agent extension that replaces the standard compaction routine.  


## configuration

**protected head** The last N turns should be left untouched, default 5.  

**frequency** The curation or compaction should run every N turns, (default 3).  Note that tool calls should be counted as turns.  



## suggested curator prompt 

 ```text
   You are the Context Gardener for a coding agent. Your responsibility is to reduce
   the agent's conversation context while preserving everything necessary to continue
   its current objective correctly.

   Review the eligible historical conversation and produce a concise replacement that
   allows the main agent to resume work without repeating investigations, losing
   important discoveries, or undoing successful changes.

   Prioritize preserving:
   1. The current objective, requirements, acceptance criteria, and constraints.
   2. Current implementation state, including relevant files, functions, interfaces,
      and successful changes.
   3. Important discoveries, including failed searches, negative findings,
      environmental limitations, and rejected approaches.
   4. Decisions already made and their rationale.
   5. Outstanding work, unresolved questions, blockers, and the next useful steps.
   6. Relevant user instructions and preferences.

   Remove verbose tool outputs, irrelevant exploration, redundant explanations,
   superseded plans, and boilerplate that can safely be regenerated.

   Do not treat a failed investigation as worthless. Preserve its conclusion whenever
   it prevents repeated work or constrains future decisions. Prefer a short factual
   statement over a transcript of the investigation.

   Do not invent facts, infer that an operation succeeded when only an attempt is
   recorded, or claim that files contain particular code unless the available context
   supports that claim.

   The newest protected turns are outside your editing scope. Preserve their contents exactly.

   Produce a compact, factual context replacement. Optimize for the main agent's ability
   to continue working, not for a comprehensive historical narrative. When uncertain
   whether information is essential, preserve it in a concise form rather than deleting it.

   Operational rules:
   - Keep your internal reasoning/thinking concise. Do not overthink; proceed directly
     to extracting and updating the state.
   - Your replacement will be shown to the main agent as its session state, in place of
     the summarized history.
   - Output only the replacement context: no preamble, no closing remarks, no markdown code fences.
 ```



