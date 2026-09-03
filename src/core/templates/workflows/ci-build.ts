/**
 * Skill Template Workflow Modules
 *
 * CI build workflow for triggering and checking company pipeline builds.
 */
import type { SkillTemplate, CommandTemplate } from '../types.js';

const CI_BUILD_WORKFLOW_INSTRUCTIONS = `Commit and push the current code when needed, trigger a remote CI pipeline build, and report whether the build passed.

**Purpose**: Use the company DevOps pipeline through \`devops-cli\` to validate code in the remote Git repository. This workflow is separate from \`/infra:verify\`: \`/infra:verify\` checks local implementation completeness, while this workflow prepares pushed code and checks remote CI build status.

**Input**: \`/infra:ci-build [changeName]\` may include an optional InfraSpec change name. If \`changeName\` is provided, use \`infraspec/changes/<changeName>/requirements-description.md\` as the primary source for the generated commit comment. If no \`changeName\` is provided, generate the commit comment from the current Git changes.

**User Experience**
- All user-facing output must be in Chinese.
- Keep the workflow fast and compact. Do not narrate every internal command or paste raw command output when parsing succeeds.
- Only show information that needs user action, a one-line progress update for major phases, errors, and the final result.
- Avoid repeating the same card, branch, pipeline, build number, commit, or URL in multiple places.
- If there is exactly one eligible Kanban card, auto-select it and show one short line. If multiple eligible Kanban cards exist, recommend the best matching card based on the current code changes before asking the user to confirm or change it.
- If there is exactly one parsed pipeline, auto-select it and show one short line. Ask the user only when multiple pipelines exist.
- Combine confirmations whenever possible. Before Git write commands, show one compact confirmation block with the selected card, commit message, branch, files, and commands.
- During CI polling, poll once per minute for at most 10 minutes, show at most one short progress line, and do not print every polling attempt.
- For successful builds, keep the final report under 8 lines unless the user asks for details.
- For failed builds, put the key failure status and first relevant ERROR line in red using \`<span style="color:red">...</span>\`. If the renderer does not show color, also prefix the line with \`【ERROR】\`.

**Important**
- This workflow triggers a remote CI build. Do not run it unless the user asked for CI, pipeline, or remote build verification.
- Remote CI builds the code available in the remote repository. Local changes must be committed and pushed before CI can validate them.
- Never commit, push, install global packages, or change source files without explicit user confirmation.
- Before running \`git add\`, list all changed and untracked files and ask the user to select the exact files to include in the CI commit.
- Before committing, show the files that will be staged and the final commit message.
- Do not use \`git add .\`. Stage only the files the user explicitly selects and confirms.
- The commit message must use exactly this format: \`<卡片编号> #comment <comment>\`.
- The card number (\`卡片编号\`) must come from a Kanban card returned by \`devops kanban get-card-by-date\` whose board display is exactly \`开发板 > 开发自测-doing\`.
- The card name shown in the commit confirmation must come from the selected card's \`taskName\` returned by \`devops kanban get-card-by-date\`. If the selected card has no \`taskName\`, display \`未返回卡片名称\`.
- Generate the \`<comment>\` automatically, then let the user edit it before committing.
- The generated \`<comment>\` must be one line, concise, and must not include the card number, \`#comment\`, quotes, or newlines.
- Only install global packages after the user explicitly confirms the install command.
- The \`name\` column returned by \`devops pipeline get-detail-by-repourl\` is the pipeline code used by later commands.
- Treat the optional \`changeName\` input as a change name, not as a pipeline code. Pipeline code is selected from the discovered pipeline list.
- Trigger pipeline builds with \`devops pipeline build --branch <branch> --pipeline-code <code>\`. Default \`<branch>\` to the current local branch, and let the user edit it before triggering the build.
- The commit confirmation must be compact and direct. Start it with \`卡片名称\`, \`分支\`, \`commit message\`, and the exact \`git commit\` command that will run.

**Steps**

1. **Check local Git context**

   Run:

   \`\`\`bash
   git status --short
   git status -sb
   git rev-parse --abbrev-ref HEAD
   git rev-parse HEAD
   \`\`\`

   Record:
   - whether the working tree has uncommitted changes
   - current branch
   - current commit id
   - whether the branch has an upstream
   - whether the branch is ahead of or behind its upstream

   If the current directory is not a Git repository, stop and report that CI build requires a Git repository.

2. **Install or check devops-cli availability**

   Run:

   \`\`\`bash
   command -v devops
   \`\`\`

   If \`devops\` is not installed, ask the user whether to install the package globally:

   \`\`\`bash
   npm install -g @LM08.02/devops-cli
   \`\`\`

   If the user confirms, run the install command, then run \`command -v devops\` again.
   If the user declines or installation fails, stop and report that the CI build cannot continue until \`devops\` is available.
   If \`devops\` is already installed, do not reinstall it.

3. **Ensure DevOps login**

   Run:

   \`\`\`bash
   devops login
   \`\`\`

   If login fails or requires user interaction that cannot complete in the current environment, stop and report the login issue.

4. **Prepare code for remote CI**

   Remote CI validates pushed code. Before discovering and triggering a pipeline, make sure the intended code is available in the remote repository.

   Re-check local changes:

   \`\`\`bash
   git status --short
   git diff --stat
   \`\`\`

   If there are uncommitted changes:

   1. Present the changed files to the user, grouped by status when possible.
   2. Ask the user to select the exact files that should be included in the CI commit before running \`git add\`.
   3. If the user selects no files, do not commit. Ask whether to continue with the current remote repository state or stop.
   4. If the user selects files, prepare the required commit message.

   To prepare the required commit message, always query Kanban cards from the last 3 local calendar days, including today. Use the current local date as \`END_DATE\` and the date 2 days before the current local date as \`START_DATE\`. Do not ask the user for a Kanban date range.

   Run:

   \`\`\`bash
   END_DATE=$(date +%F)
   START_DATE=$(date -v-2d +%F 2>/dev/null || date -d "2 days ago" +%F)
   devops kanban get-card-by-date --start-date "$START_DATE" --end-date "$END_DATE"
   \`\`\`

   Do not show the raw query output when parsing succeeds. If no eligible card is found, include the fixed 3-day query range in the short failure message.

   The command output may be either raw JSON or formatted console text printed by \`console.log\`.

   If the output is valid JSON, parse the JSON response and read \`body.list\`. For each card, extract backend \`taskKey\` as the card number (\`卡片编号\`), \`taskName\` as the card name (\`卡片名称\`), \`description\`, \`taskGroupName\`, \`relatedFeatureKey\`, \`relatedRequirementKey\`, \`relatedFeatureTaskKey\`, \`updatedTime\`, \`boardName\`, and \`columnName\`. Compose the card's board display as \`\${boardName} > \${columnName}\`.

   If the output is formatted console text, parse it from the logged lines. Each card may look like:

   \`\`\`text
   卡片编号： M10000749-9
   卡片名称： 功能-关联特性
   负责人： 王宇壮
   看板： 开发板 > 开发自测-doing
   任务组： 长度超长的卡片名称测试
   --------------------------------------------------------------------------------
   \`\`\`

   Split cards by the separator line or by each \`卡片编号\` line. Extract the card id with a pattern equivalent to:

   \`\`\`text
   /卡片编号[:：]\\s*(\\S+)/
   \`\`\`

   Treat the extracted value as the card number (\`卡片编号\`). Also extract optional display fields when present:
   - \`卡片名称[:：]\` as \`taskName\`
   - \`负责人[:：]\` as \`taskAssigneeName\`
   - \`看板[:：]\` as the full board display text, for example \`开发板 > 开发自测-doing\`
   - \`任务组[:：]\` as \`taskGroupName\`
   - \`描述[:：]\` as \`description\`
   - \`更新时间[:：]\` as \`updatedTime\`

   Before presenting cards to the user, filter the parsed cards. Only cards whose board display is exactly \`开发板 > 开发自测-doing\` are eligible for the commit message.
   - For JSON output, match the composed board display \`\${boardName} > \${columnName}\`.
   - For formatted console text, match the parsed \`看板\` value.
   - Trim surrounding whitespace before comparing, but do not treat other columns such as \`开发自测-done\`, \`投产-doing\`, or other boards as eligible.

   If exactly one eligible card remains after filtering, auto-select it and print only:
   \`已选择开发自测卡片：<卡片编号> <卡片名称>\`

   If multiple eligible cards remain, rank them by how well they match the current code changes before presenting them. Use these change signals:
   - the optional \`changeName\` and \`infraspec/changes/<changeName>/requirements-description.md\`
   - selected file paths
   - \`git diff --stat\`
   - relevant diff context
   - the generated commit comment
   - the current branch name

   Compare those signals with card fields such as \`卡片名称\`, \`description\`, \`任务组\`, \`relatedFeatureKey\`, \`relatedRequirementKey\`, and \`relatedFeatureTaskKey\`. Prefer the eligible card with the strongest business or technical match. Do not select a card only because it appears first in the DevOps CLI output.

   If one card is clearly the best match, recommend it first and show a short Chinese reason, for example:

   \`\`\`text
   推荐卡片：<卡片编号> <卡片名称>
   匹配依据：<one short reason from requirement, changed files, diff, or branch>
   \`\`\`

   Ask the user to confirm the recommended card or choose another card only when there are multiple eligible cards. If there is no clear best match, present the eligible cards sorted by likely relevance with compact Chinese labels. Include at least:
   - 卡片编号
   - 卡片名称
   - 看板
   - 所在列
   - 负责人
   - 更新时间
   - 任务组

   In all user-facing card selection text, call the value \`卡片编号\`; do not call it \`taskKey\` or any other label.
   Keep the selected card's \`taskName\` for the final commit confirmation display.
   If no eligible cards are returned after filtering, tell the user: \`没有开发自测-doing中的卡片\`. Stop before generating the commit message and do not run \`git add\`, \`git commit\`, \`git push\`, or any pipeline build command.

   Generate the commit comment automatically:
   - If \`changeName\` was provided and \`infraspec/changes/<changeName>/requirements-description.md\` exists, read that file and summarize the original requirement into a concise commit comment.
   - Also inspect the selected file list and \`git diff --stat\`; use them to keep the comment aligned with the actual code changes.
   - If \`changeName\` was not provided, or the requirements description file does not exist, generate the comment from the selected file list, \`git diff --stat\`, and relevant diff context.
   - Prefer Chinese when the requirement or file context is Chinese.
   - Keep the comment specific enough to describe the business or technical change, for example \`新增流水线构建工作流\` or \`修复接口超时处理逻辑\`.

   Compose the commit message exactly as:

   \`\`\`text
   \${cardNumber} #comment \${comment}
   \`\`\`

   Show the generated commit comment and full commit message to the user, then ask whether they want to edit the comment.
   If the user edits the comment, recompose the full commit message with the same selected card number.

   Before running any Git write command, show a single compact commit confirmation block in this exact shape:

   \`\`\`markdown
   卡片名称：<taskName>
   分支：<branch>
   commit message: <卡片编号> #comment <comment>
   待提交文件：<N> 个

   将执行的 git commit 命令：
   git commit -m "<卡片编号> #comment <comment>"
   git push
   \`\`\`

   Then list the exact user-selected files to stage below the block in a compact list. Do not scatter the card name, commit message, branch, and commit command across separate sections.

   Ask for explicit confirmation to stage only the selected files, commit, and push.
   If the user confirms, run:

   \`\`\`bash
   git add -- <confirmed-files>
   git commit -m "<卡片编号> #comment <comment>"
   git push
   \`\`\`

   If the branch has no upstream, ask for confirmation before using:

   \`\`\`bash
   git push -u origin <branch>
   \`\`\`

   If \`git add\`, \`git commit\`, or \`git push\` fails, stop and report the failure. Do not trigger CI for code that failed to push.
   Never add files that were not included in the user's selected file list.

   If there are no uncommitted changes, check whether local commits are ahead of the upstream branch. Use \`git status -sb\` and, when an upstream exists:

   \`\`\`bash
   git log --oneline @{u}..HEAD
   \`\`\`

   If there are unpushed commits, show them to the user and ask for confirmation before running \`git push\`.
   If the branch has no upstream, ask for confirmation before running \`git push -u origin <branch>\`.
   If there are no local changes and no unpushed commits, continue without committing or pushing.

   After any successful commit or push, run:

   \`\`\`bash
   git rev-parse HEAD
   \`\`\`

   Record this as the pushed commit id expected in the CI result.

5. **Get repository URL**

   Prefer:

   \`\`\`bash
   git remote get-url origin
   \`\`\`

   If there is no \`origin\`, run:

   \`\`\`bash
   git remote -v
   \`\`\`

   Ask the user which remote URL to use only when multiple plausible repository URLs exist. If there is a single \`origin\` URL, use it silently and mention it only in the final result or on failure.

6. **Discover pipelines for the repository**

   Run:

   \`\`\`bash
   devops pipeline get-detail-by-repourl --repo-url "<url>"
   \`\`\`

   The command output may be raw JSON, a whitespace table, or formatted console text printed by \`console.log\`.

   If the output is valid JSON, parse the JSON response. Pipeline records may be in a top-level array, \`body\`, \`body.list\`, or another obvious array field. Extract at least \`name\` and \`env\` from each record.

   If the output is a table, parse the header row and map column names. For a table like:

   \`\`\`text
   id      name      pipelineAlias                 env  branch  pipelineType
   687692  pl687692  LD85.04_CoSpace_ST_ST         ST   *       CONTAINER_SERVICE
   \`\`\`

   extract the value under the \`name\` column as the pipeline code and the value under the \`env\` column as the environment.

   If the output is formatted console text, parse it from the logged lines. Each pipeline may look like:

   \`\`\`text
   id: 687692
   name: pl687692
   pipelineAlias: LD85.04_CoSpace_ST_ST
   env: ST
   branch: *
   pipelineType: CONTAINER_SERVICE
   --------------------------------------------------------------------------------
   \`\`\`

   Split pipelines by the separator line or by each \`name\` line. Extract fields with patterns equivalent to:

   \`\`\`text
   /name[:：]\\s*(\\S+)/
   /env[:：]\\s*(\\S+)/
   /id[:：]\\s*(\\S+)/
   /pipelineAlias[:：]\\s*(.+)/
   /branch[:：]\\s*(\\S+)/
   /pipelineType[:：]\\s*(\\S+)/
   \`\`\`

   Also tolerate Chinese labels when present:
   - \`流水线编码[:：]\` or \`流水线名称[:：]\` as \`name\`
   - \`环境[:：]\` as \`env\`
   - \`分支[:：]\` as \`branch\`
   - \`流水线类型[:：]\` as \`pipelineType\`

   If exactly one pipeline is parsed, auto-select it and print only:
   \`已选择流水线：<name>（<env>）\`

   If multiple pipelines are parsed, present a compact selection list. Every option label must include both \`name\` and \`env\`, because the same repository may have multiple pipelines for different environments. Include at least:
   - id
   - name
   - pipelineAlias
   - env
   - branch
   - pipelineType

   Ask the user to select which \`name\` value should be used as \`<code>\` only when multiple pipelines are parsed.
   Use the selected \`name\`, not \`id\` or \`pipelineAlias\`, for later commands.
   If no \`name\` values can be extracted, stop and show the raw output so the user can diagnose the DevOps CLI output format.

7. **Trigger the pipeline build**

   Determine the branch to build:
   - Default to the current local branch recorded from \`git rev-parse --abbrev-ref HEAD\`.
   - Do not ask a separate branch question when the default branch is usable. Include the branch in the compact confirmation and let the user reply with a different branch there.
   - Use the confirmed branch value as \`<branch>\`.
   - If the confirmed build branch differs from the current local branch, explain that CI will build the remote code for the confirmed branch, then ask for explicit confirmation before continuing.
   - If no branch can be determined and the user does not provide one, stop before triggering the pipeline.

   Run:

   \`\`\`bash
   devops pipeline build --branch "<branch>" --pipeline-code "<code>"
   \`\`\`

   Capture and summarize the command output in one Chinese line. If the command fails, stop and report the failure.

   Parse the command output and extract the \`buildNumber\` returned by this build trigger command. Record it as \`triggeredBuildNumber\`.
   The output may be JSON or formatted text. If it is JSON, read the top-level \`buildNumber\` field. If it is formatted text, extract a field named \`buildNumber\`, \`Build Number\`, or \`构建编号\`.

   If no \`buildNumber\` can be extracted from the build trigger output, stop and report that the workflow cannot safely identify the current CI build report. Do not fall back to the latest completed build, because it may be the previous build.

   After extracting \`triggeredBuildNumber\`, construct the pipeline detail URL from the selected pipeline \`name\` value and the triggered build number:

   \`\`\`text
   https://pipeline.paas.cmbchina.cn/pipeline/detail/<code>?buildNumber=<triggeredBuildNumber>
   \`\`\`

8. **Fetch the triggered build detail**

   Fetch the detail for the exact build triggered by this workflow. Do not use \`devops pipeline latest-build-detail\` here, because it can return a previous completed build.

   Run:

   \`\`\`bash
   devops pipeline build-detail --pipeline-code "<code>" --pipeline-number "<triggeredBuildNumber>"
   \`\`\`

   The command output may be raw JSON or formatted console text printed by \`console.log\`.

   If the output is valid JSON, parse the JSON response. Build fields may be in a top-level object, \`body\`, or another obvious detail object. Record:
   - id
   - pipelineName
   - pipelineAlias
   - buildNumber
   - env
   - branch
   - tag
   - commitId
   - status
   - artifactUrl
   - triggerBy
   - startTime
   - completedTime
   - stages

   Also parse failed stage detail fields when present. They may appear in fields such as \`failedStages\`, \`failureStage\`, \`stageDetails\`, \`stages\`, or a similar array/object. Extract:
   - \`stageCode\`
   - \`stageName\`
   - \`stageBuildId\`
   - \`stageBuildNumber\`
   - \`status\`
   - \`errorMessage\`

   If the output is formatted console text, parse fields with patterns equivalent to:

   \`\`\`text
   /流水线名称[:：]\\s*(.+)/
   /流水线别名[:：]\\s*(.+)/
   /构建版本号[:：]\\s*(\\S+)/
   /构建状态[:：]\\s*(\\S+)/
   /Git\\s*分支[:：]\\s*(\\S+)/
   /Commit[:：]\\s*(\\S+)/
   /开始时间[:：]\\s*(.+)/
   /阶段编码[:：]\\s*(.+)/
   /阶段名称[:：]\\s*(.+)/
   /构建步骤\\s*ID[:：]\\s*(\\S+)/
   /错误信息[:：]\\s*(.*)/
   \`\`\`

   Treat \`构建步骤 ID\` as \`stageBuildId\`; this is the value required by \`devops pipeline build-log --stage-build-id\`.
   For \`错误信息\`, capture the text after the label and any following lines that belong to the failed stage detail until the next obvious section header or separator.

   If the detail response contains a \`buildNumber\` or \`构建版本号\` and it does not equal \`triggeredBuildNumber\`, mark the result as inconclusive and do not analyze it as the current CI result.
   If the response says the build detail is not available yet, or the status is still running/pending, wait and rerun the same \`build-detail\` command until a terminal status is available or until the 10-minute timeout is reached.

   Use a bounded polling loop, for example:
   - show one short Chinese progress line before polling starts
   - wait 1 minute between checks
   - stop after 10 minutes
   - do not print each polling attempt

   If the 10-minute timeout is reached and the triggered build detail is still unavailable or still running, report the current result immediately as running or inconclusive. Tell the user that the triggered build report is not available yet and ask them to check the exact pipeline detail URL:
   - \`https://pipeline.paas.cmbchina.cn/pipeline/detail/<code>?buildNumber=<triggeredBuildNumber>\`

9. **Classify build status**

   Treat these statuses as passed:
   - \`SUCCESS\`
   - \`SUCCEEDED\`
   - \`PASSED\`

   Treat these statuses as failed:
   - \`FAILED\`
   - \`FAILURE\`
   - \`ABORTED\`
   - \`CANCELED\`
   - \`CANCELLED\`
   - \`TIMEOUT\`
   - \`TIMED_OUT\`

   Treat these statuses as still running or inconclusive:
   - \`RUNNING\`
   - \`BUILDING\`
   - \`PENDING\`
   - \`QUEUED\`
   - missing or unknown status

   If the returned \`commitId\` is present and differs from the pushed commit id, mark the result as inconclusive for the current local checkout and explain the mismatch.

   If the build status is failed, analyze the failure reason before reporting:
   - Inspect the failed stage details and \`stages\` parsed from \`devops pipeline build-detail\`. Identify failed or abnormal stages, including statuses such as \`FAILED\`, \`FAILURE\`, \`ABORTED\`, \`CANCELED\`, \`CANCELLED\`, \`TIMEOUT\`, and \`TIMED_OUT\`.
   - Identify the first failed or abnormal stage in pipeline order when possible.
   - Include each abnormal stage's \`name\`, \`type\`, \`status\`, \`stageBuildId\`, and \`stageBuildNumber\` when available.
   - If the top-level status is \`ABORTED\` or canceled, include \`abortedBy\`, \`cancelBy\`, \`triggerBy\`, and \`completedTime\` when available.
   - Extract the failed stage's \`stageBuildId\`. For formatted console text, this comes from \`构建步骤 ID\`.
   - If a failed \`stageBuildId\` is available, fetch the failed stage log:

     \`\`\`bash
     devops pipeline build-log --pipeline-code "<code>" --stage-build-id "<stageBuildId>"
     \`\`\`

   - The \`build-log\` output may be very long. Never show the full log by default.
   - Split the log into lines and locate lines containing \`ERROR\`. Treat the match as case-sensitive unless the log clearly uses another case consistently.
   - Show only the first relevant \`ERROR\` context by default: at most 50 lines before the \`ERROR\` line and at most 50 lines after it. Include line numbers when possible.
   - If multiple \`ERROR\` lines are close together, merge overlapping 50-line windows. If there are many separate \`ERROR\` clusters, show the first cluster and say how many additional ERROR lines or clusters were omitted.
   - If no \`ERROR\` line is found, do not dump the full log. Say that no \`ERROR\` line was found and fall back to the failed stage metadata and \`错误信息\` from \`build-detail\`.
   - If the top-level status is failed but no stage carries a failed status, say that the CLI response does not expose the exact failed stage and point the user to the pipeline detail URL for logs.
   - Do not invent log content or root causes that are not present in the \`build-detail\` or \`build-log\` response. Separate observed facts from inferred likely causes.

10. **Report the result**

   Use this concise Chinese format:

   \`\`\`markdown
   ## CI构建结果

   结论：<通过 / 失败 / 运行中 / 不确定>
   流水线：<pipelineName or code>（<env>） | 构建：#<triggeredBuildNumber>
   分支：<branch from CI result or confirmed build branch> | Commit：<short commitId>
   提交：<卡片编号> <卡片名称> | 文件：<N 个文件 or not pushed by this workflow>
   详情：https://pipeline.paas.cmbchina.cn/pipeline/detail/<code>?buildNumber=<triggeredBuildNumber>

   ### 失败原因
   <span style="color:red">失败阶段：<first failed or abnormal stage></span>
   <span style="color:red">【ERROR】<first relevant ERROR line or build-detail error message></span>
   建议：<specific next check, usually pipeline detail URL or failed stage logs>

   ### 错误日志（截取）
   \`\`\`text
   <only the ERROR line and up to 50 lines before and 50 lines after it; omit this section when no ERROR log context is available>
   \`\`\`

   备注：<working tree or commit mismatch notes, omit if none>
   \`\`\`

**Output Rules**
- 输出必须使用中文。
- 明确这是远程 CI 结果，但不要反复解释远程 CI 的含义。
- 成功时只输出结论、流水线/构建号、分支/Commit、提交摘要、详情链接，不输出阶段列表。
- 失败时输出 \`### 失败原因\`，并用红色突出失败阶段和第一条相关 \`ERROR\`。
- 如果构建失败且存在 \`stageBuildId\`，运行 \`devops pipeline build-log --pipeline-code "<code>" --stage-build-id "<stageBuildId>"\`，并且只展示 \`ERROR\` 行及其前后最多 50 行。
- 如果 \`build-detail\` 或 \`build-log\` 没有返回日志或明确错误信息，用一句中文说明，并且只放一次流水线详情链接。
- 如果构建还在运行，提示用户稍后重跑 \`devops pipeline build-detail --pipeline-code "<code>" --pipeline-number "<triggeredBuildNumber>"\` 查看结果。
- 轮询构建结果时每 1 分钟检查一次，最多等待 10 分钟，不要逐次输出检查结果；超过 10 分钟仍未完成时直接报告当前结果并返回精确流水线详情链接。
- 只有 CI 返回的 commitId 与本次推送的 commit id 一致，且本地没有剩余未提交改动时，才能说明当前改动通过 CI。`;

export function getCiBuildSkillTemplate(): SkillTemplate {
  return {
    name: 'infra-ci-build',
    description: 'Commit and push code when needed, trigger a remote CI pipeline build with devops-cli, and report whether it passed. Use when the user wants to run company CI/CD pipeline validation.',
    instructions: CI_BUILD_WORKFLOW_INSTRUCTIONS,
    compatibility: 'Requires Git, InfraSpec CLI (`infraspec`), and company DevOps CLI (`devops`).',
    metadata: { author: 'bianyongmei', version: '1.0' },
  };
}

export function getOpsxCiBuildCommandTemplate(): CommandTemplate {
  return {
    name: 'INFRA: CI Build',
    description: 'Commit and push code when needed, trigger a remote CI pipeline build, and inspect the triggered build result',
    category: 'Workflow',
    tags: ['workflow', 'ci', 'pipeline', 'build'],
    content: CI_BUILD_WORKFLOW_INSTRUCTIONS,
  };
}
