/**
 * Business Requirement Workflow Modules
 *
 * Business-product requirement workflow for creating product-manager-facing
 * Word documents while keeping InfraSpec review compatibility.
 */
import type { SkillTemplate, CommandTemplate } from '../types.js';

const BIZ_WORKFLOW_INSTRUCTIONS = `Create a business-product requirement change for product managers, then keep it compatible with the normal InfraSpec review workflow.

**Purpose**: Use this workflow when the user wants to write a business or product requirement document, not a technical requirement document. The primary output is a Word requirement document for product managers and business reviewers. This workflow is a peer upstream entry to \`/infra:new\`; after it finishes, the user should continue with \`/infra:review <changeName>\`.

**Input**: \`/infra:biz\` may include a business requirement description, a title, or a path to an existing requirement file. If the input is a file path and the file exists, read it first and use the file content as the original business requirement input.

**Important**
- All user-facing output must be in Chinese.
- Do not implement application code in this workflow.
- Do not treat this as a technical \`requirements.md\` flow. \`/infra:new\` is for technical requirement feature documents; \`/infra:biz\` is for business-product Word requirement documents.
- The business Word document must not expose code details. Do not include source file paths, function names, class names, method names, imports, code snippets, stack traces, or implementation commands in \`requirements.docx\`.
- Code facts may be used only as internal grounding. Translate them into business rules, business flows, constraints, exception scenarios, acceptance criteria, or impacted user operations.
- If code-derived behavior is uncertain, write \`待业务确认\` instead of presenting it as a confirmed business rule.
- The required Word output should be \`requirements.docx\`. Do not generate old binary \`.doc\` unless the user explicitly requires a legacy Word-compatible file.
- Prefer low-dependency diagram generation. Generate SVG diagrams directly from structured definitions; do not require Mermaid, PlantUML, Pandoc, browser screenshots, or globally installed packages by default.
- Keep \`requirements.md\` as an internal downstream input for \`/infra:review <changeName>\`. Product managers use \`requirements.docx\`; AI/engineering review uses \`requirements.md\`.

**Expected change directory**

\`\`\`text
infraspec/changes/<changeName>/
  .infraspec.yaml
  requirement-description.md
  biz-requirements.json
  biz-code-insights.md
  requirements.docx
  requirements.md
  code-context.md
  assets/
    panorama-prototype.svg
    feature-1-flow.svg
    feature-1-design.svg
    feature-2-flow.svg
    feature-2-design.svg
\`\`\`

\`biz-code-insights.md\` is optional when code analysis is unavailable or not relevant. If created, it is an internal translation note and must use business language rather than raw code references.

**Steps**

1. **Understand the business requirement**

   If no clear input was provided, ask the user:
   > "请描述要编写的业务产品类需求，或提供已有需求文档路径。"

   Identify:
   - business title
   - target users
   - business goal and value
   - products/modules involved
   - feature list
   - business rules
   - flow and design diagram needs
   - metrics, performance, security, and acceptance criteria

   If a change name is not explicit, derive a kebab-case \`changeName\` from the business title or core requirement. If the name is ambiguous, ask the user to confirm the name before creating the change.

2. **Create the InfraSpec change**

   Run:

   \`\`\`bash
   infraspec new change "<changeName>"
   \`\`\`

   Use the default schema unless the user explicitly asks for another schema. If the change already exists, ask whether to continue the existing change or choose another name.

3. **Save the original requirement input**

   Write the original input to:

   \`\`\`text
   infraspec/changes/<changeName>/requirement-description.md
   \`\`\`

   Preserve the user's original wording. If the input came from a file, include the source file path and then the full file content.

4. **Ask whether to ground with business knowledge**

   Always ask the user whether they want to query the company business knowledge base for this business requirement.
   - If no, continue without querying and record a short note such as \`业务知识库查询：用户选择跳过\` in \`biz-requirements.json.assumptions\` if useful.
   - If yes, read \`infraspec/config.yaml\` and look for:

   \`\`\`yaml
   businessKnowledge:
     productId: <productId>
     botId: <botId>
   \`\`\`

   If \`infraspec/config.yaml\` does not exist or either value is missing, ask the user to consult the business owner and provide \`productId\` and \`botId\`.

   After the user provides them, create or update \`infraspec/config.yaml\` by adding or replacing only this block:

   \`\`\`yaml
   businessKnowledge:
     productId: <productId>
     botId: <botId>
   \`\`\`

   If the file does not exist, create it with \`schema: spec-driven\` plus the \`businessKnowledge\` block. Preserve existing \`schema\`, \`context\`, \`rules\`, comments, and any unknown fields. Do not write these values to \`AGENTS.md\`.

   Confirm that both \`productId\` and \`botId\` are available before calling the API. Then call the same retrieve API used by \`/infra:explore\`:

   \`\`\`bash
   PRODUCT_ID="<productId>"
   BOT_ID="<botId>"
   QUESTION="<business requirement question>"
   URL="http://aidoc.paasuat.cn/AIDocKnowledgeService/api/v1/products/$PRODUCT_ID/bots/$BOT_ID/retrieve"

   node -e '
   const [url, question] = process.argv.slice(1);
   fetch(url, {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({
       question,
       userId: "675538",
       docDataStatusList: [0, 1],
     }),
   })
     .then(async (response) => {
       const text = await response.text();
       if (!response.ok) {
         throw new Error("HTTP " + response.status + ": " + text);
       }
       console.log(text);
     })
     .catch((error) => {
       console.error(error.message);
       process.exit(1);
     });
   ' "$URL" "$QUESTION"
   \`\`\`

   Request body rules:
   - \`question\`: the user's business requirement question
   - \`userId\`: always \`675538\`
   - \`docDataStatusList\`: always \`[0, 1]\`
   - Do not send \`invokeChannel\`
   - Do not send \`datasetIds\`

   If the HTTP call fails or the response cannot be parsed, explain the failure briefly, continue from the user's input, and record the lookup failure in \`biz-requirements.json.assumptions\`.

5. **Optionally refresh code context**

   For existing-system changes, run:

   \`\`\`bash
   infraspec code analyze --change "<changeName>" --json
   \`\`\`

   If it succeeds, read \`infraspec/changes/<changeName>/code-context.md\`. If it fails, continue without blocking the business document.

   When using code context, first translate it into \`biz-code-insights.md\`:
   - convert entry points into user/business operations
   - convert validation and branches into business rules and exception scenarios
   - convert status fields into business state transitions
   - convert permissions into role and access rules
   - convert logs or metrics into tracking or operational requirements only when business relevant
   - remove raw code references from the business-facing wording

6. **Create \`biz-requirements.json\`**

   Generate a structured JSON file at:

   \`\`\`text
   infraspec/changes/<changeName>/biz-requirements.json
   \`\`\`

   Use this schema shape:

   \`\`\`json
   {
     "title": "<业务需求标题>",
     "overview": {
       "role": "<用户角色>",
       "want": "<用户想完成的业务动作>",
       "benefit": "<业务价值>",
       "summary": "<一段业务需求概述>"
     },
     "metrics": [
       {
         "name": "<指标名称>",
         "rule": "<指标说明或计算规则>",
         "target": "<目标值>",
         "baseline": "<基准值或本次未明确>"
       }
     ],
     "panorama": {
       "description": "<需求全景描述>",
       "background": "<背景>",
       "goals": ["<目标>"],
       "values": ["<价值>"],
       "prototype": {
         "title": "<原型图标题>",
         "type": "wireframe",
         "elements": []
       }
     },
     "features": [
       {
         "id": "F1",
         "name": "<功能名称>",
         "scope": "<适用范围>",
         "overview": "<功能概述>",
         "flowDiagram": {
           "title": "<流程图标题>",
           "nodes": [],
           "edges": []
         },
         "designDiagram": {
           "title": "<设计图标题>",
           "type": "wireframe",
           "elements": []
         },
         "businessRules": ["<业务规则>"],
         "acceptanceCriteria": ["<验收标准>"]
       }
     ],
     "supplemental": {
       "performance": [
         { "type": "业务处理性能", "description": "<性能需求或本次未明确>" },
         { "type": "业务容量", "description": "<性能需求或本次未明确>" },
         { "type": "业务响应时间", "description": "<性能需求或本次未明确>" },
         { "type": "日终批处理能力", "description": "<性能需求或本次未明确>" }
       ],
       "securityAssessment": [
         {
           "category": "<安全评估分类>",
           "items": [
             { "name": "<评估项>", "checked": false, "reason": "<选择依据或本次未明确>" }
           ]
         }
       ]
     },
     "assumptions": ["<待确认或假设>"]
   }
   \`\`\`

   Rules:
   - Use business language.
   - Replace placeholders with concrete content where possible.
   - Keep missing information as \`本次未明确\` or \`待业务确认\`.
   - Do not include code snippets or raw code identifiers.
   - If the requirement explicitly mentions tracking or buried points, include them under \`businessRules\` or \`acceptanceCriteria\`; do not create a fixed buried-point section.

7. **Generate diagrams**

   Create \`infraspec/changes/<changeName>/assets/\`.

   Generate:
   - one panorama prototype diagram at \`assets/panorama-prototype.svg\`
   - for each feature, one flow diagram at \`assets/feature-<n>-flow.svg\`
   - for each feature, one design diagram at \`assets/feature-<n>-design.svg\`

   Diagram rules:
   - Use SVG by default.
   - Keep diagrams low-fidelity and readable.
   - Flow diagrams should show start, decisions, main steps, exception paths, and end states.
   - Design diagrams should show page/entry layout, key fields, buttons, states, messages, and visible business information.
   - Do not rely on external rendering tools unless they are already available.
   - If a diagram cannot be produced, leave a short visible placeholder in the Word document and record the gap in \`biz-requirements.json.assumptions\`.

8. **Create the business Word document**

   Create:

   \`\`\`text
   infraspec/changes/<changeName>/requirements.docx
   \`\`\`

   Follow this exact outline:

   \`\`\`text
   标题

   1. 需求概述
   2. 关联专题衡量指标
   3. 需求全景
      3.1 需求全景描述
      3.2 原型图
      3.3 功能清单
   4. 功能详情
      4.1 <功能名称>
      4.1.1 功能概述
      4.1.2 流程图
      4.1.3 设计图
      4.1.4 业务规则
      4.1.5 验收标准
   5. 补充需求
      5.1 业务性能需求描述
      5.2 安全评估
   \`\`\`

   Content rules:
   - Section 1 should use product/user-story language: \`作为...\`、\`我想要...\`、\`以便...\`.
   - Section 2 must be a table with columns: \`指标名称\`、\`指标说明（计算规则）\`、\`目标值\`、\`基准值（选填）\`.
   - Section 3.1 must include a table or paragraphs for \`背景\`、\`目标\`、\`价值\`.
   - Section 3.2 must include the panorama prototype diagram.
   - Section 3.3 must be a function list table with columns: \`类型\`、\`关联数字产品\`、\`关联模块\`、\`功能名称\`、\`关联实施组\`、\`负责人\`.
   - Section 4 must repeat the five fixed subsections for every feature.
   - Section 5.1 must be a table with columns: \`性能类型\`、\`性能需求描述\`, and rows for \`业务处理性能\`、\`业务容量\`、\`业务响应时间\`、\`日终批处理能力\`.
   - Section 5.2 must be a safety checklist grouped by security category. Pre-check only items clearly implied by the requirement; otherwise leave unchecked and add \`待确认\` when needed.
   - Keep typography and tables clean for Word/WPS review. Avoid dense code-like text.

   Word content examples:
   - Use these examples as format guidance only. Replace the sample content with the current requirement; do not copy example facts into the document.
   - Section 1 example:
     作为运营人员，我想要在统一页面查看并处理待办任务，以便减少跨系统切换并提升处理效率。
   - Section 2 table example:
     | 指标名称 | 指标说明（计算规则） | 目标值 | 基准值（选填） |
     | --- | --- | --- | --- |
     | 人工处理效率 | 单个业务任务从进入待办到完成处理的平均耗时 | 较当前流程降低 30% | 本次未明确 |
     | 任务处理准确率 | 正确完成处理的任务数 / 总处理任务数 | >= 99% | 本次未明确 |
   - Section 3.1 must use this fixed background/goal/value shape:
     | 项目 | 内容 |
     | --- | --- |
     | 背景 | 当前业务处理分散在多个入口，用户需要反复切换页面，容易遗漏待办和异常状态。 |
     | 目标 | 建立统一处理入口，集中展示待办、处理动作、处理结果和异常提示。 |
     | 价值 | 降低操作成本，提升处理效率，增强业务过程可追踪性。 |
   - Section 3.2 prototype diagram example:
     图题：图 3.2-1 统一待办处理原型图
     内容：插入 \`assets/panorama-prototype.svg\`，图下用 1-2 句话说明页面入口、核心区域、主要按钮和状态信息。
   - Section 3.3 function list example:
     | 类型 | 关联数字产品 | 关联模块 | 功能名称 | 关联实施组 | 负责人 |
     | --- | --- | --- | --- | --- | --- |
     | 新增 | 本次未明确 | 待办中心 | 统一待办列表 | 本次未明确 | 本次未明确 |
     | 优化 | 本次未明确 | 任务处理 | 处理结果反馈 | 本次未明确 | 本次未明确 |
   - Section 4 feature detail examples:
     4.1.1 功能概述：说明该功能服务的业务对象、用户动作、输入输出和完成后的业务状态。
     4.1.2 流程图：插入对应 \`assets/feature-<n>-flow.svg\`，图中必须包含开始、判断、正常处理、异常处理和结束。
     4.1.3 设计图：插入对应 \`assets/feature-<n>-design.svg\`，图中必须包含关键字段、按钮、状态、提示语和错误信息。
     4.1.4 业务规则：使用编号列表描述可验证规则，例如“同一任务同一时间只能由一名处理人提交处理结果”。
     4.1.5 验收标准：使用“Given/When/Then”或中文等价表达，覆盖成功路径、异常路径、权限和边界条件。
   - Section 5.1 performance table example:
     | 性能类型 | 性能需求描述 |
     | --- | --- |
     | 业务处理性能 | 支持工作时间内连续处理待办任务，提交处理结果后系统应稳定返回处理状态。 |
     | 业务容量 | 支持本次业务范围内的任务量，具体峰值本次未明确。 |
     | 业务响应时间 | 页面查询、提交、刷新等用户操作响应时间本次未明确，待业务确认。 |
     | 日终批处理能力 | 本次未明确。 |
   - Section 5.2 security assessment example:
     | 安全分类 | 评估项 | 是否涉及 | 说明 |
     | --- | --- | --- | --- |
     | 权限控制 | 是否存在角色差异化访问 | 是 | 不同角色可查看和处理的任务范围不同。 |
     | 敏感信息 | 是否展示客户或交易敏感信息 | 待确认 | 原始需求未明确展示字段。 |

   If a dependable docx writer is available in the current agent environment, use it. If no docx writer is available, create the Word document with the lowest available dependency path and clearly tell the user what format was generated. Do not ask the user to install new software.

9. **Create internal \`requirements.md\` for \`/infra:review\`**

   Create:

   \`\`\`text
   infraspec/changes/<changeName>/requirements.md
   \`\`\`

   This file is not the product-manager deliverable. It is a technical handoff document for the existing review workflow. Convert \`biz-requirements.json\` into the company technical requirements structure expected by \`/infra:review\`, including:
   - business background, goal, and value
   - function list
   - business rules
   - acceptance criteria
   - performance and security requirements
   - user/business flows from the diagrams
   - assumptions and \`待确认事项\`

   It may reference code-context at a high level only when useful for engineering handoff. Keep enough detail for \`/infra:review <changeName>\` to generate \`detailed-design.md\`, \`proposal.md\`, \`specs\`, \`design.md\`, and \`tasks.md\`.

10. **Validate outputs**

   Before finishing, verify:
   - \`requirements.docx\` exists
   - \`biz-requirements.json\` exists and is valid JSON
   - \`requirements.md\` exists for downstream \`/infra:review\`
   - required SVG assets exist or gaps are recorded
   - the Word/business content does not include raw code details

   If docx visual rendering tools are available, render and inspect the document. If not, at least inspect the generated file list and document source content.

**Output**

After completion, summarize in Chinese:
- Change name
- Word document path
- Internal \`requirements.md\` path
- Diagram asset paths
- Any assumptions or missing confirmations
- Next step: \`/infra:review <changeName>\`

**Guardrails**
- Do not create implementation code.
- Do not auto-run \`/infra:review\`.
- Do not put raw code details in \`requirements.docx\`.
- Do not require product managers to read Markdown.
- Keep the business Word document and internal technical handoff separate.
- If information is missing, mark it as \`本次未明确\` or \`待业务确认\`, not as a fact.`;

export function getBizSkillTemplate(): SkillTemplate {
  return {
    name: 'infra-biz',
    description: 'Create business-product requirement Word documents for product managers, including flow diagrams, prototype/design diagrams, business rules, and an internal requirements.md handoff for infra-review.',
    instructions: BIZ_WORKFLOW_INSTRUCTIONS,
    compatibility: 'Requires InfraSpec CLI (`infraspec`).',
    metadata: { author: 'bianyongmei', version: '1.0' },
  };
}

export function getOpsxBizCommandTemplate(): CommandTemplate {
  return {
    name: 'INFRA: Biz',
    description: 'Use the infra-biz skill to create a business-product Word requirement document and an internal requirements.md handoff',
    category: 'Workflow',
    tags: ['workflow', 'business', 'requirements', 'word'],
    content: BIZ_WORKFLOW_INSTRUCTIONS.replaceAll('/infra:biz', '/infra-biz').replaceAll('/infra:review', '/infra-review'),
  };
}
