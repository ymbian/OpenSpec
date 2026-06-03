/**
 * Skill Template Workflow Modules
 *
 * Wiki workflow for generating code-backed project documentation.
 */
import type { SkillTemplate, CommandTemplate } from '../types.js';

const WIKI_WORKFLOW_INSTRUCTIONS = `Generate or refresh an InfraSpec code wiki from the current codebase.

**Purpose**: Treat source code as the source of truth and generate a traceable wiki that helps the team and new joiners understand the project implementation.

**Input**: \`/infra:wiki\` may include an optional scope, such as a module name, directory, feature area, or "full". If omitted, generate or refresh the main project wiki.

**Important**
- This workflow is Agent-driven in this version. Do not assume an \`infraspec wiki sync\` CLI exists yet.
- Prefer InfraSpec code graph data. Use context-sized code graph query commands instead of reading the full \`index.json\` into model context.
- Large projects usually produce an \`index.json\` that is too large for coding-agent context windows. Never load the full \`index.json\` unless it is clearly small and necessary.
- Do not modify application source code.
- Keep wiki pages grounded in actual code facts. Do not invent architecture, modules, flows, or responsibilities.

**Steps**

1. **Identify wiki scope**

   Determine whether the user wants:
   - Full project wiki
   - A specific module wiki
   - A feature/flow wiki
   - A refresh of existing wiki pages

   If the request is ambiguous, choose a reasonable full-project default and state the assumption.

2. **Load a context-sized module manifest**

   Do not read the full global index into context. Instead, ask the InfraSpec CLI for a compact module manifest:

   \`\`\`bash
   infraspec code modules --json
   \`\`\`

   This command will load \`infraspec/.code-graph/index.json\` if it exists, or generate it if it is missing.

   The module manifest is the primary planning input for this workflow:
   - global stats
   - module ids and names
   - module confidence
   - root paths
   - layers
   - language mix
   - file and symbol counts
   - sample files
   - entry point and execution flow counts

   If the user explicitly asks for a full refresh, or if the existing wiki appears stale, refresh the index first:

   \`\`\`bash
   infraspec code modules --refresh --json
   \`\`\`

   The global index file still lives at:
   \`infraspec/.code-graph/index.json\`

   Treat it as a backing data file, not as text to paste into the model context.

   If \`infraspec code modules --json\` fails, try a direct index generation once:

   \`\`\`bash
   infraspec code index --json
   \`\`\`

   Then retry:

   \`\`\`bash
   infraspec code modules --json
   \`\`\`

   If both module-manifest loading and index generation fail, do not stop the wiki workflow. Fall back to direct repository inspection with fast file search and targeted code reads, and clearly mention in the output:
   - code graph generation was attempted
   - why it failed, if known
   - the wiki was generated from direct source inspection instead of code graph query commands
   - no temporary InfraSpec change was created for wiki indexing

3. **Plan wiki batches**

   Build a page-generation plan from the compact module manifest.

   For a full-project wiki:
   - Generate the top-level pages first: \`index.md\` and \`architecture.md\`.
   - Then process modules one at a time.
   - Prefer modules with higher confidence, more entry points, or more execution flows first.
   - Do not keep multiple large module payloads in context at the same time.

   For a scoped wiki:
   - Match the requested scope against module id, module name, root paths, layers, terms, and sample files.
   - Process only the matching module or small set of modules.

   For very large modules:
   - If a module has many files or the module detail result is truncated, split the wiki output by directory or layer.
   - Recommended split pages:
     \`\`\`text
     infraspec/wiki/modules/<module>.md
     infraspec/wiki/modules/<module>/<layer-or-directory>.md
     \`\`\`
   - Use root paths and layers from the module manifest to decide the split.
   - Keep each generated page focused on one module, layer, directory, or execution flow.

4. **Load one module slice at a time**

   Before writing a module page, load only that module's graph slice:

   \`\`\`bash
   infraspec code module "<module-id>" --json
   \`\`\`

   If the module is still too large for the current context, use smaller limits:

   \`\`\`bash
   infraspec code module "<module-id>" --json --max-files 40 --max-symbols 80 --max-flows 10 --max-edges 120
   \`\`\`

   The module slice contains:
   - module metadata
   - files for that module
   - symbols for that module
   - entry points for that module
   - execution flows for that module
   - graph edges touching that module
   - truncation flags

   If truncation flags are true, acknowledge the limitation and inspect the most important source files directly.

5. **Inspect source code**

   Use repository search and targeted file reads to confirm the wiki content even when module graph slices are available. The code graph is a structural map; source files remain the final source of truth.

   Focus on:
   - Entry points: CLI commands, controllers, routes, jobs, pages, React components, app bootstrap files
   - Core modules: service, domain, infra, persistence, API, UI, config, tests
   - Important flows: request handling, command execution, state changes, external integration
   - Existing documentation: README, AGENTS.md, docs, specs, infraspec artifacts

6. **Create wiki directory structure**

   Write wiki pages under:
   \`infraspec/wiki/\`

   Recommended first version structure:
   \`\`\`text
   infraspec/wiki/
     index.md
     architecture.md
     modules/
       <module>.md
     execution-flows/
       <execution-flow>.md
     _meta/
       sources.json
       stale.json
   \`\`\`

   Create only the pages supported by the inspected code. Do not create empty placeholder pages.

7. **Generate module and execution-flow pages**

   Prefer the compact output from \`infraspec code modules --json\` as the primary wiki skeleton.

   - If the module manifest is non-empty, generate one page per meaningful module under \`infraspec/wiki/modules/\`.
   - For each module page, use \`infraspec code module "<module-id>" --json\` to load only that module's details.
   - If module detail is truncated, generate a concise module overview first, then optionally split deeper pages by layer or directory.
   - If modules are missing or empty, infer modules from directory structure, file names, and symbols, and mention this fallback in the summary.
   - Use module-level \`entryPoints\` to populate "Entry Points" sections in module pages.
   - Use module-level \`executionFlows\` to generate high-confidence pages under \`infraspec/wiki/execution-flows/\` or to populate "Related Execution Flows" sections in module pages.
   - Do not invent execution flows. If \`executionFlows\` is empty or low confidence, write concise "Flow hints" from code inspection instead of a fake call chain.
   - After finishing a module page, release that module's large payload from working context before processing the next module.

8. **Write traceable wiki pages**

   Each generated page should include frontmatter with source references:
   \`\`\`md
   ---
   title: <page title>
   type: overview | architecture | module | flow | decision
   generated_by: infra-wiki
   sources:
     - file: src/example.ts
       symbols: [Example]
       hash: <source hash if available>
   stale: false
   ---
   \`\`\`

   Page content should prefer this structure:
   - Purpose
   - Key responsibilities
   - Important files and symbols
   - Entry points
   - Related execution flows or call relationships
   - Configuration and external dependencies, if any
   - Change risks
   - Verification hints

9. **Generate \`index.md\`**

   \`infraspec/wiki/index.md\` should be the team entry point:
   - Project summary
   - Technology stack inferred from files and configs
   - Main modules
   - Main entry points
   - Main execution flows when available
   - Links to generated pages
   - How to refresh this wiki

10. **Generate metadata**

   Write \`infraspec/wiki/_meta/sources.json\` with machine-readable traceability:
   - page path
   - source files
   - source hashes when available
   - symbols
   - module ids
   - entry point ids
   - execution flow ids
   - generatedAt
   - graphIndexPath: \`infraspec/.code-graph/index.json\` when code graph query commands were used
   - graphGeneratedForWiki: true if this workflow generated the index

   Write \`infraspec/wiki/_meta/stale.json\` with an initial status:
   - stale pages: empty for newly generated pages
   - unchecked pages: pages whose source hash could not be determined
   - notes: limitations and assumptions

11. **Output summary**

   Summarize:
   - Pages created or refreshed
   - Modules, entry points, and execution flows used from code graph query commands
   - Source files inspected
   - Whether \`infraspec/.code-graph/index.json\` existed, was generated, refreshed, or unavailable
   - Whether any module pages were split by layer or directory because of context size
   - Any pages that need manual review
   - Suggested next command, for example: "Run \`/infra:wiki <module>\` to deepen a module page."

**Guardrails**
- Do not generate a polished but ungrounded wiki. Code facts beat narrative guesses.
- Do not overwrite manually curated content without preserving useful human-written notes.
- If an existing wiki page has manual content, merge carefully and keep traceability metadata current.
- If code graph data conflicts with actual source files, trust the source files and mention the mismatch.
- Keep the wiki useful for humans first: concise explanations, clear links, and explicit source references.`;

export function getWikiSkillTemplate(): SkillTemplate {
  return {
    name: 'infra-wiki',
    description: 'Generate or refresh a traceable code wiki from the current codebase. Use when the user wants source-backed project documentation for onboarding, architecture understanding, or knowledge maintenance.',
    instructions: WIKI_WORKFLOW_INSTRUCTIONS,
    compatibility: 'Requires InfraSpec CLI (`infraspec`).',
    metadata: { author: 'bianyongmei', version: '1.0' },
  };
}

export function getOpsxWikiCommandTemplate(): CommandTemplate {
  return {
    name: 'INFRA: Wiki',
    description: '根据当前代码生成或刷新可追溯的项目 Wiki（INFRA）',
    category: 'Workflow',
    tags: ['workflow', 'wiki', 'code-graph', 'documentation'],
    content: WIKI_WORKFLOW_INSTRUCTIONS.replaceAll('/infra:wiki', '/infra-wiki'),
  };
}
