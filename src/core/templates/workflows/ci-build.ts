/**
 * Skill Template Workflow Modules
 *
 * CI build workflow for triggering and checking company pipeline builds.
 */
import type { SkillTemplate, CommandTemplate } from '../types.js';

const CI_BUILD_WORKFLOW_INSTRUCTIONS = `Commit and push the current code when needed, trigger a remote CI pipeline build, and report whether the build passed.

**Purpose**: Use the company DevOps pipeline through \`devops-cli\` to validate code in the remote Git repository. This workflow is separate from \`/infra:verify\`: \`/infra:verify\` checks local implementation completeness, while this workflow prepares pushed code and checks remote CI build status.

**Input**: \`/infra:ci-build [changeName]\` may include an optional InfraSpec change name. If \`changeName\` is provided, use \`infraspec/changes/<changeName>/requirements-description.md\` as the primary source for the generated commit comment. If no \`changeName\` is provided, generate the commit comment from the current Git changes.

**Important**
- This workflow triggers a remote CI build. Do not run it unless the user asked for CI, pipeline, or remote build verification.
- Remote CI builds the code available in the remote repository. Local changes must be committed and pushed before CI can validate them.
- Never commit, push, install global packages, or change source files without explicit user confirmation.
- Before committing, show the files that will be staged and the final commit message.
- Do not use \`git add .\`. Stage only the files the user confirms.
- The commit message must use exactly this format: \`<taskKey> #comment <comment>\`.
- The \`taskKey\` must come from \`body.list[*].taskKey\` returned by \`devops kanban get-card-by-date\`, unless the command fails and the user manually provides a task key.
- Generate the \`<comment>\` automatically, then let the user edit it before committing.
- The generated \`<comment>\` must be one line, concise, and must not include the task key, \`#comment\`, quotes, or newlines.
- Only install global packages after the user explicitly confirms the install command.
- The \`name\` column returned by \`devops pipeline get-detail-by-repourl\` is the pipeline code used by later commands.
- Treat the optional \`changeName\` input as a change name, not as a pipeline code. Pipeline code is selected from the discovered pipeline list.

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
   2. Ask the user which files should be included in the CI commit.
   3. If the user selects no files, do not commit. Ask whether to continue with the current remote repository state or stop.
   4. If the user selects files, prepare the required commit message.

   To prepare the required commit message, always query Kanban cards from the last 3 local calendar days, including today. Use the current local date as \`END_DATE\` and the date 2 days before the current local date as \`START_DATE\`. Do not ask the user for a Kanban date range.

   Run:

   \`\`\`bash
   END_DATE=$(date +%F)
   START_DATE=$(date -v-2d +%F 2>/dev/null || date -d "2 days ago" +%F)
   devops kanban get-card-by-date --start-date "$START_DATE" --end-date "$END_DATE"
   \`\`\`

   Show the fixed 3-day query range to the user before presenting cards.

   The command output may be either raw JSON or formatted console text printed by \`console.log\`.

   If the output is valid JSON, parse the JSON response and read \`body.list\`. Extract \`taskKey\` from each card.

   If the output is formatted console text, parse it from the logged lines. Each card may look like:

   \`\`\`text
   卡片编号： M10000749-9
   卡片名称： 功能-关联特性
   负责人： 王宇壮
   看板： 当前迭代板 > 投产-doing
   任务组： 长度超长的卡片名称测试
   --------------------------------------------------------------------------------
   \`\`\`

   Split cards by the separator line or by each \`卡片编号\` line. Extract the card id with a pattern equivalent to:

   \`\`\`text
   /卡片编号[:：]\\s*(\\S+)/
   \`\`\`

   Treat the extracted value as \`taskKey\`. Also extract optional display fields when present:
   - \`卡片名称[:：]\` as \`taskName\`
   - \`负责人[:：]\` as \`taskAssigneeName\`
   - \`看板[:：]\` as board and column display text
   - \`任务组[:：]\` as \`taskGroupName\`

   Present all returned cards to the user. Include at least:
   - taskKey
   - taskName
   - boardName
   - columnName
   - taskAssigneeName
   - updatedTime
   - taskGroupName

   Ask the user to select the \`taskKey\` to use in the commit message.
   If no cards are returned or no \`taskKey\` can be extracted from either JSON or console text, explain the issue and ask the user to provide the task key manually.

   Generate the commit comment automatically:
   - If \`changeName\` was provided and \`infraspec/changes/<changeName>/requirements-description.md\` exists, read that file and summarize the original requirement into a concise commit comment.
   - Also inspect the selected file list and \`git diff --stat\`; use them to keep the comment aligned with the actual code changes.
   - If \`changeName\` was not provided, or the requirements description file does not exist, generate the comment from the selected file list, \`git diff --stat\`, and relevant diff context.
   - Prefer Chinese when the requirement or file context is Chinese.
   - Keep the comment specific enough to describe the business or technical change, for example \`新增流水线构建工作流\` or \`修复接口超时处理逻辑\`.

   Compose the commit message exactly as:

   \`\`\`text
   \${taskKey} #comment \${comment}
   \`\`\`

   Show the generated commit comment and full commit message to the user, then ask whether they want to edit the comment.
   If the user edits the comment, recompose the full commit message with the same selected \`taskKey\`.

   Before running any Git write command, show:
   - files to stage
   - selected taskKey
   - final commit message
   - target branch and upstream when known

   Ask for explicit confirmation to commit and push.
   If the user confirms, run:

   \`\`\`bash
   git add -- <confirmed-files>
   git commit -m "<taskKey> #comment <comment>"
   git push
   \`\`\`

   If the branch has no upstream, ask for confirmation before using:

   \`\`\`bash
   git push -u origin <branch>
   \`\`\`

   If \`git add\`, \`git commit\`, or \`git push\` fails, stop and report the failure. Do not trigger CI for code that failed to push.

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

   Ask the user which remote URL to use when multiple plausible repository URLs exist.

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

   Present all parsed pipelines to the user. Every option label must include both \`name\` and \`env\`, because the same repository may have multiple pipelines for different environments. Include at least:
   - id
   - name
   - pipelineAlias
   - env
   - branch
   - pipelineType

   Ask the user to select which \`name\` value should be used as \`<code>\`.
   Use the selected \`name\`, not \`id\` or \`pipelineAlias\`, for later commands.
   If no \`name\` values can be extracted, stop and show the raw output so the user can diagnose the DevOps CLI output format.

7. **Trigger the pipeline build**

   Run:

   \`\`\`bash
   devops pipeline build --pipeline-code "<code>"
   \`\`\`

   Capture and summarize the command output. If the command fails, stop and report the failure.

   Parse the command output and extract the \`buildNumber\` returned by this build trigger command. Record it as \`triggeredBuildNumber\`.
   The output may be JSON or formatted text. If it is JSON, read the top-level \`buildNumber\` field. If it is formatted text, extract a field named \`buildNumber\`, \`Build Number\`, or \`构建编号\`.

   If no \`buildNumber\` can be extracted from the build trigger output, stop and report that the workflow cannot safely identify the current CI build report. Do not fall back to the latest completed build, because it may be the previous build.

8. **Fetch the triggered build detail**

   \`devops pipeline latest-build-detail --pipeline-code "<code>"\` returns the latest completed pipeline report. Immediately after triggering a new build, that command may still return the previous completed build.

   Run:

   \`\`\`bash
   devops pipeline latest-build-detail --pipeline-code "<code>"
   \`\`\`

   Parse the JSON response. Record:
   - id
   - pipelineName
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

   If the response is not valid JSON, show the raw output and mark the CI result as unknown.
   If the response is valid JSON, compare the returned \`buildNumber\` with \`triggeredBuildNumber\`:
   - If they match, treat this response as the report for the build triggered by this workflow.
   - If they do not match, do not use this response as the current CI result. Explain that the latest completed report is for a different build number and the triggered build has probably not completed yet.
   - Wait and rerun \`devops pipeline latest-build-detail --pipeline-code "<code>"\` until the returned \`buildNumber\` equals \`triggeredBuildNumber\`, or until a reasonable timeout is reached.

   Use a bounded polling loop, for example:
   - wait 30 seconds between checks
   - stop after 20 checks or 10 minutes

   If the timeout is reached and the returned \`buildNumber\` still does not match \`triggeredBuildNumber\`, mark the result as running or inconclusive. Do not report the previous build result to the user. Tell the user that the triggered build report is not available yet and ask them to check the pipeline platform:
   - https://pipeline.paas.cmbchina.cn/v2/pipeline/view

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

10. **Report the result**

   Use this format:

   \`\`\`markdown
   ## CI Build Report

   | Field | Value |
   |-------|-------|
   | Pipeline | <pipelineName> |
   | Build | #<buildNumber> |
   | Environment | <env> |
   | Branch | <branch> |
   | Commit | <commitId> |
   | Triggered Build Number | #<triggeredBuildNumber> |
   | Status | <status> |

   ### Assessment
   <Passed, Failed, Running, or Inconclusive>

   ### Submitted Code
   - Local branch: <branch>
   - Pushed commit: <pushed commit id or not pushed by this workflow>
   - Kanban task: <taskKey or not used>
   - Commit message: <commit message or not created by this workflow>
   - Triggered buildNumber: <triggeredBuildNumber>

   ### Stage Summary
   - <stage name> (<type>): <status or not reported>

   ### Notes
   - <working tree or commit mismatch notes>
   \`\`\`

**Output Rules**
- Be explicit that this is a remote CI result.
- If the build failed, list failed or abnormal stages when available.
- If the build is still running, tell the user which command to rerun to check again.
- Do not claim the current local changes passed CI unless the CI commit id matches the pushed commit id and there are no remaining uncommitted changes.`;

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
    description: 'Commit and push code when needed, trigger a remote CI pipeline build, and inspect the latest build result',
    category: 'Workflow',
    tags: ['workflow', 'ci', 'pipeline', 'build'],
    content: CI_BUILD_WORKFLOW_INSTRUCTIONS,
  };
}
