/**
 * Init Command
 *
 * Sets up InfraSpec with Agent Skills and /infra:* slash commands.
 * This is the unified setup command that replaces both the old init and experimental commands.
 */

import path from 'path';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import { createRequire } from 'module';
import { FileSystemUtils } from '../utils/file-system.js';
import { transformToHyphenCommands } from '../utils/command-references.js';
import {
  AI_TOOLS,
  OPENSPEC_DIR_NAME,
  AIToolOption,
} from './config.js';
import { PALETTE } from './styles/palette.js';
import { isInteractive } from '../utils/interactive.js';
import { serializeConfig } from './config-prompts.js';
import {
  generateCommands,
  CommandAdapterRegistry,
} from './command-generation/index.js';
import {
  detectLegacyArtifacts,
  cleanupLegacyArtifacts,
  formatCleanupSummary,
  formatDetectionSummary,
  type LegacyDetectionResult,
} from './legacy-cleanup.js';
import {
  SKILL_NAMES,
  getToolsWithSkillsDir,
  getToolSkillStatus,
  getToolStates,
  getSkillTemplates,
  getCommandContents,
  generateSkillContent,
  type ToolSkillStatus,
} from './shared/index.js';
import { getGlobalConfig, type Delivery, type Profile } from './global-config.js';
import { getProfileWorkflows, CORE_WORKFLOWS, ALL_WORKFLOWS } from './profiles.js';
import { getAvailableTools } from './available-tools.js';
import { migrateIfNeeded } from './migration.js';

const require = createRequire(import.meta.url);
const { version: OPENSPEC_VERSION } = require('../../package.json');

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_SCHEMA = 'spec-driven';
const DEFAULT_CONFIG_CONTEXT = [
  '默认使用中文编写 proposal.md、design.md 和 tasks.md。',
  '当任务需要进行编译或构建校验时，统一使用 `infraspec/build-check.sh` 作为项目标准入口。',
].join('\n');
const DEFAULT_CONFIG_RULES: Record<string, string[]> = {
  proposal: [
    '默认使用中文编写 proposal.md。',
  ],
  design: [
    '默认使用中文编写 design.md。',
  ],
  tasks: [
    '默认使用中文编写 tasks.md。',
    '最后的验证任务应显式要求执行 `infraspec/build-check.sh`，修复所有编译/构建错误，并重复执行直到校验通过。',
  ],
};

const PROGRESS_SPINNER = {
  interval: 80,
  frames: ['░░░', '▒░░', '▒▒░', '▒▒▒', '▓▒▒', '▓▓▒', '▓▓▓', '▒▓▓', '░▒▓'],
};

const WORKFLOW_TO_SKILL_DIR: Record<string, string> = {
  'explore': 'infra-explore',
  'new': 'infra-new-change',
  'wiki': 'infra-wiki',
  'continue': 'infra-continue-change',
  'review': 'infra-review-change',
  'apply': 'infra-apply-change',
  'ff': 'infra-ff-change',
  'sync': 'infra-sync-specs',
  'archive': 'infra-archive-change',
  'bulk-archive': 'infra-bulk-archive-change',
  'verify': 'infra-verify-change',
  'onboard': 'infra-onboard',
  'propose': 'infra-propose',
};

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type InitCommandOptions = {
  tools?: string;
  force?: boolean;
  interactive?: boolean;
  profile?: string;
};

type GitHookInstallStatus =
  | 'configured'
  | 'already-configured'
  | 'skipped-no-git'
  | 'skipped-existing-hooks'
  | 'failed';

type GitRepositorySetupStatus =
  | 'existing'
  | 'initialized'
  | 'skipped-not-new'
  | 'skipped-parent-repo'
  | 'failed';

type BuildVerificationSetupStatus = {
  gitRepository: GitRepositorySetupStatus;
  agents: 'created' | 'exists';
  agentRules: AgentRulesSetupStatus;
  preCommitHook: 'created' | 'exists';
  buildCheck: 'created' | 'exists';
  hookInstall: GitHookInstallStatus;
};

type AgentRulesSetupStatus = {
  directory: 'created' | 'exists';
  index: 'created' | 'exists';
  codingPrinciples: 'created' | 'exists';
  sdd: 'created' | 'exists';
  verification: 'created' | 'exists';
  javaSonar?: 'created' | 'exists';
  frontendLint?: 'created' | 'exists';
};

type ProjectLanguageProfile = {
  java: boolean;
  frontend: boolean;
};

// -----------------------------------------------------------------------------
// Init Command Class
// -----------------------------------------------------------------------------

export class InitCommand {
  private readonly toolsArg?: string;
  private readonly force: boolean;
  private readonly interactiveOption?: boolean;
  private readonly profileOverride?: string;

  constructor(options: InitCommandOptions = {}) {
    this.toolsArg = options.tools;
    this.force = options.force ?? false;
    this.interactiveOption = options.interactive;
    this.profileOverride = options.profile;
  }

  async execute(targetPath: string): Promise<void> {
    const projectPath = path.resolve(targetPath);
    const openspecDir = OPENSPEC_DIR_NAME;
    const openspecPath = path.join(projectPath, openspecDir);

    // Validation happens silently in the background
    const extendMode = await this.validate(projectPath, openspecPath);

    // Check for legacy artifacts and handle cleanup
    await this.handleLegacyCleanup(projectPath, extendMode);

    // Initialize Git early if the target looks like a brand-new standalone project.
    const gitRepositoryStatus = await this.ensureGitRepository(projectPath);

    // Detect available tools in the project (task 7.1)
    const detectedTools = getAvailableTools(projectPath);

    // Migration check: migrate existing projects to profile system (task 7.3)
    if (extendMode) {
      migrateIfNeeded(projectPath, detectedTools);
    }

    // Show animated welcome screen (interactive mode only)
    const canPrompt = this.canPromptInteractively();
    if (canPrompt) {
      const { showWelcomeScreen } = await import('../ui/welcome-screen.js');
      await showWelcomeScreen();
    }

    // Validate profile override early so invalid values fail before tool setup.
    // The resolved value is consumed later when generation reads effective config.
    this.resolveProfileOverride();

    // Get tool states before processing
    const toolStates = getToolStates(projectPath);

    // Get tool selection (pass detected tools for pre-selection)
    const selectedToolIds = await this.getSelectedTools(toolStates, extendMode, detectedTools, projectPath);

    // Validate selected tools
    const validatedTools = this.validateTools(selectedToolIds, toolStates);

    // Create directory structure and config
    await this.createDirectoryStructure(openspecPath, extendMode);

    // Generate skills and commands for each tool
    const results = await this.generateSkillsAndCommands(projectPath, validatedTools);

    // Create config.yaml if needed
    const configStatus = await this.createConfig(openspecPath, extendMode);

    // Create project-level AI coding guardrails and Git hook files
    const buildVerificationStatus = await this.setupBuildVerification(projectPath, gitRepositoryStatus);

    // Display success message
    this.displaySuccessMessage(projectPath, validatedTools, results, configStatus, buildVerificationStatus);
  }

  // ═══════════════════════════════════════════════════════════
  // VALIDATION & SETUP
  // ═══════════════════════════════════════════════════════════

  private async validate(
    projectPath: string,
    openspecPath: string
  ): Promise<boolean> {
    const extendMode = await FileSystemUtils.directoryExists(openspecPath);

    // Check write permissions
    if (!(await FileSystemUtils.ensureWritePermissions(projectPath))) {
      throw new Error(`Insufficient permissions to write to ${projectPath}`);
    }
    return extendMode;
  }

  private canPromptInteractively(): boolean {
    if (this.interactiveOption === false) return false;
    if (this.toolsArg !== undefined) return false;
    return isInteractive({ interactive: this.interactiveOption });
  }

  private resolveProfileOverride(): Profile | undefined {
    if (this.profileOverride === undefined) {
      return undefined;
    }

    if (this.profileOverride === 'core' || this.profileOverride === 'custom') {
      return this.profileOverride;
    }

    throw new Error(`Invalid profile "${this.profileOverride}". Available profiles: core, custom`);
  }

  // ═══════════════════════════════════════════════════════════
  // LEGACY CLEANUP
  // ═══════════════════════════════════════════════════════════

  private async handleLegacyCleanup(projectPath: string, extendMode: boolean): Promise<void> {
    // Detect legacy artifacts
    const detection = await detectLegacyArtifacts(projectPath);

    if (!detection.hasLegacyArtifacts) {
      return; // No legacy artifacts found
    }

    // Show what was detected
    console.log();
    console.log(formatDetectionSummary(detection));
    console.log();

    const canPrompt = this.canPromptInteractively();

    if (this.force) {
      // --force flag: proceed with cleanup automatically
      await this.performLegacyCleanup(projectPath, detection);
      return;
    }

    if (!canPrompt) {
      // Non-interactive mode without --force: abort
      console.log(chalk.red('Legacy files detected in non-interactive mode.'));
      console.log(chalk.dim('Run interactively to upgrade, or use --force to auto-cleanup.'));
      process.exit(1);
    }

    // Interactive mode: prompt for confirmation
    const { confirm } = await import('@inquirer/prompts');
    const shouldCleanup = await confirm({
      message: 'Upgrade and clean up legacy files?',
      default: true,
    });

    if (!shouldCleanup) {
      console.log(chalk.dim('Initialization cancelled.'));
      console.log(chalk.dim('Run with --force to skip this prompt, or manually remove legacy files.'));
      process.exit(0);
    }

    await this.performLegacyCleanup(projectPath, detection);
  }

  private async performLegacyCleanup(projectPath: string, detection: LegacyDetectionResult): Promise<void> {
    const spinner = ora('Cleaning up legacy files...').start();

    const result = await cleanupLegacyArtifacts(projectPath, detection);

    spinner.succeed('Legacy files cleaned up');

    const summary = formatCleanupSummary(result);
    if (summary) {
      console.log();
      console.log(summary);
    }

    console.log();
  }

  // ═══════════════════════════════════════════════════════════
  // TOOL SELECTION
  // ═══════════════════════════════════════════════════════════

  private async getSelectedTools(
    toolStates: Map<string, ToolSkillStatus>,
    extendMode: boolean,
    detectedTools: AIToolOption[],
    projectPath: string
  ): Promise<string[]> {
    // Check for --tools flag first
    const nonInteractiveSelection = this.resolveToolsArg();
    if (nonInteractiveSelection !== null) {
      return nonInteractiveSelection;
    }

    const validTools = getToolsWithSkillsDir();
    const detectedToolIds = new Set(detectedTools.map((t) => t.value));
    const configuredToolIds = new Set(
      [...toolStates.entries()]
        .filter(([, status]) => status.configured)
        .map(([toolId]) => toolId)
    );
    const shouldPreselectDetected = !extendMode && configuredToolIds.size === 0;
    const canPrompt = this.canPromptInteractively();

    // Non-interactive mode: use detected tools as fallback (task 7.8)
    if (!canPrompt) {
      if (detectedToolIds.size > 0) {
        return [...detectedToolIds];
      }
      throw new Error(
        `No tools detected and no --tools flag provided. Valid tools:\n  ${validTools.join('\n  ')}\n\nUse --tools all, --tools none, or --tools claude,cursor,...`
      );
    }

    if (validTools.length === 0) {
      throw new Error(
        `No tools available for skill generation.`
      );
    }

    // Interactive mode: show searchable multi-select
    const { searchableMultiSelect } = await import('../prompts/searchable-multi-select.js');

    // Build choices: pre-select configured tools; keep detected tools visible but unselected.
    const sortedChoices = validTools
      .map((toolId) => {
        const tool = AI_TOOLS.find((t) => t.value === toolId);
        const status = toolStates.get(toolId);
        const configured = status?.configured ?? false;
        const detected = detectedToolIds.has(toolId);

        return {
          name: tool?.name || toolId,
          value: toolId,
          configured,
          detected: detected && !configured,
          preSelected: configured || (shouldPreselectDetected && detected && !configured),
        };
      })
      .sort((a, b) => {
        // Configured tools first, then detected (not configured), then everything else.
        if (a.configured && !b.configured) return -1;
        if (!a.configured && b.configured) return 1;
        if (a.detected && !b.detected) return -1;
        if (!a.detected && b.detected) return 1;
        return 0;
      });

    const configuredNames = validTools
      .filter((toolId) => configuredToolIds.has(toolId))
      .map((toolId) => AI_TOOLS.find((t) => t.value === toolId)?.name || toolId);

    if (configuredNames.length > 0) {
      console.log(`InfraSpec configured: ${configuredNames.join(', ')} (pre-selected)`);
    }

    const detectedOnlyNames = detectedTools
      .filter((tool) => !configuredToolIds.has(tool.value))
      .map((tool) => tool.name);

    if (detectedOnlyNames.length > 0) {
      const detectionLabel = shouldPreselectDetected
        ? 'pre-selected for first-time setup'
        : 'not pre-selected';
      console.log(`Detected tool directories: ${detectedOnlyNames.join(', ')} (${detectionLabel})`);
    }

    const selectedTools = await searchableMultiSelect({
      message: `Select tools to set up (${validTools.length} available)`,
      pageSize: 15,
      choices: sortedChoices,
      validate: (selected: string[]) => selected.length > 0 || 'Select at least one tool',
    });

    if (selectedTools.length === 0) {
      throw new Error('At least one tool must be selected');
    }

    return selectedTools;
  }

  private resolveToolsArg(): string[] | null {
    if (typeof this.toolsArg === 'undefined') {
      return null;
    }

    const raw = this.toolsArg.trim();
    if (raw.length === 0) {
      throw new Error(
        'The --tools option requires a value. Use "all", "none", or a comma-separated list of tool IDs.'
      );
    }

    const availableTools = getToolsWithSkillsDir();
    const availableSet = new Set(availableTools);
    const availableList = ['all', 'none', ...availableTools].join(', ');

    const lowerRaw = raw.toLowerCase();
    if (lowerRaw === 'all') {
      return availableTools;
    }

    if (lowerRaw === 'none') {
      return [];
    }

    const tokens = raw
      .split(',')
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    if (tokens.length === 0) {
      throw new Error(
        'The --tools option requires at least one tool ID when not using "all" or "none".'
      );
    }

    const normalizedTokens = tokens.map((token) => token.toLowerCase());

    if (normalizedTokens.some((token) => token === 'all' || token === 'none')) {
      throw new Error('Cannot combine reserved values "all" or "none" with specific tool IDs.');
    }

    const invalidTokens = tokens.filter(
      (_token, index) => !availableSet.has(normalizedTokens[index])
    );

    if (invalidTokens.length > 0) {
      throw new Error(
        `Invalid tool(s): ${invalidTokens.join(', ')}. Available values: ${availableList}`
      );
    }

    // Deduplicate while preserving order
    const deduped: string[] = [];
    for (const token of normalizedTokens) {
      if (!deduped.includes(token)) {
        deduped.push(token);
      }
    }

    return deduped;
  }

  private validateTools(
    toolIds: string[],
    toolStates: Map<string, ToolSkillStatus>
  ): Array<{ value: string; name: string; skillsDir: string; wasConfigured: boolean }> {
    const validatedTools: Array<{ value: string; name: string; skillsDir: string; wasConfigured: boolean }> = [];

    for (const toolId of toolIds) {
      const tool = AI_TOOLS.find((t) => t.value === toolId);
      if (!tool) {
        const validToolIds = getToolsWithSkillsDir();
        throw new Error(
          `Unknown tool '${toolId}'. Valid tools:\n  ${validToolIds.join('\n  ')}`
        );
      }

      if (!tool.skillsDir) {
        const validToolsWithSkills = getToolsWithSkillsDir();
        throw new Error(
          `Tool '${toolId}' does not support skill generation.\nTools with skill generation support:\n  ${validToolsWithSkills.join('\n  ')}`
        );
      }

      const preState = toolStates.get(tool.value);
      validatedTools.push({
        value: tool.value,
        name: tool.name,
        skillsDir: tool.skillsDir,
        wasConfigured: preState?.configured ?? false,
      });
    }

    return validatedTools;
  }

  // ═══════════════════════════════════════════════════════════
  // DIRECTORY STRUCTURE
  // ═══════════════════════════════════════════════════════════

  private async createDirectoryStructure(openspecPath: string, extendMode: boolean): Promise<void> {
    if (extendMode) {
      // In extend mode, just ensure directories exist without spinner
      const directories = [
        openspecPath,
        path.join(openspecPath, 'specs'),
        path.join(openspecPath, 'changes'),
        path.join(openspecPath, 'changes', 'archive'),
      ];

      for (const dir of directories) {
        await FileSystemUtils.createDirectory(dir);
      }
      return;
    }

    const spinner = this.startSpinner('Creating InfraSpec structure...');

    const directories = [
      openspecPath,
      path.join(openspecPath, 'specs'),
      path.join(openspecPath, 'changes'),
      path.join(openspecPath, 'changes', 'archive'),
    ];

    for (const dir of directories) {
      await FileSystemUtils.createDirectory(dir);
    }

    spinner.stopAndPersist({
      symbol: PALETTE.white('▌'),
      text: PALETTE.white('InfraSpec structure created'),
    });
  }

  // ═══════════════════════════════════════════════════════════
  // SKILL & COMMAND GENERATION
  // ═══════════════════════════════════════════════════════════

  private async generateSkillsAndCommands(
    projectPath: string,
    tools: Array<{ value: string; name: string; skillsDir: string; wasConfigured: boolean }>
  ): Promise<{
    createdTools: typeof tools;
    refreshedTools: typeof tools;
    failedTools: Array<{ name: string; error: Error }>;
    commandsSkipped: string[];
    removedCommandCount: number;
    removedSkillCount: number;
  }> {
    const createdTools: typeof tools = [];
    const refreshedTools: typeof tools = [];
    const failedTools: Array<{ name: string; error: Error }> = [];
    const commandsSkipped: string[] = [];
    let removedCommandCount = 0;
    let removedSkillCount = 0;

    // Read global config for profile and delivery settings (use --profile override if set)
    const globalConfig = getGlobalConfig();
    const profile: Profile = this.resolveProfileOverride() ?? globalConfig.profile ?? 'core';
    const delivery: Delivery = globalConfig.delivery ?? 'both';
    const workflows = getProfileWorkflows(profile, globalConfig.workflows);

    // Get skill and command templates filtered by profile workflows
    const shouldGenerateSkills = delivery !== 'commands';
    const shouldGenerateCommands = delivery !== 'skills';
    const skillTemplates = shouldGenerateSkills ? getSkillTemplates(workflows) : [];
    const commandContents = shouldGenerateCommands ? getCommandContents(workflows) : [];

    // Process each tool
    for (const tool of tools) {
      const spinner = ora(`Setting up ${tool.name}...`).start();

      try {
        // Generate skill files if delivery includes skills
        if (shouldGenerateSkills) {
          // Use tool-specific skillsDir
          const skillsDir = path.join(projectPath, tool.skillsDir, 'skills');

          // Create skill directories and SKILL.md files
          for (const { template, dirName } of skillTemplates) {
            const skillDir = path.join(skillsDir, dirName);
            const skillFile = path.join(skillDir, 'SKILL.md');

            // Generate SKILL.md content with YAML frontmatter including generatedBy
            // Use hyphen-based command references for OpenCode
            const transformer = tool.value === 'opencode' ? transformToHyphenCommands : undefined;
            const skillContent = generateSkillContent(template, OPENSPEC_VERSION, transformer);

            // Write the skill file
            await FileSystemUtils.writeFile(skillFile, skillContent);
          }
        }
        if (!shouldGenerateSkills) {
          const skillsDir = path.join(projectPath, tool.skillsDir, 'skills');
          removedSkillCount += await this.removeSkillDirs(skillsDir);
        }

        // Generate commands if delivery includes commands
        if (shouldGenerateCommands) {
          const adapter = CommandAdapterRegistry.get(tool.value);
          if (adapter) {
            const generatedCommands = generateCommands(commandContents, adapter);

            for (const cmd of generatedCommands) {
              const commandFile = path.isAbsolute(cmd.path) ? cmd.path : path.join(projectPath, cmd.path);
              await FileSystemUtils.writeFile(commandFile, cmd.fileContent);
            }
          } else {
            commandsSkipped.push(tool.value);
          }
        }
        if (!shouldGenerateCommands) {
          removedCommandCount += await this.removeCommandFiles(projectPath, tool.value);
        }

        spinner.succeed(`Setup complete for ${tool.name}`);

        if (tool.wasConfigured) {
          refreshedTools.push(tool);
        } else {
          createdTools.push(tool);
        }
      } catch (error) {
        spinner.fail(`Failed for ${tool.name}`);
        failedTools.push({ name: tool.name, error: error as Error });
      }
    }

    return {
      createdTools,
      refreshedTools,
      failedTools,
      commandsSkipped,
      removedCommandCount,
      removedSkillCount,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // CONFIG FILE
  // ═══════════════════════════════════════════════════════════

  private async createConfig(openspecPath: string, extendMode: boolean): Promise<'created' | 'exists' | 'skipped'> {
    const configPath = path.join(openspecPath, 'config.yaml');
    const configYmlPath = path.join(openspecPath, 'config.yml');
    const configYamlExists = fs.existsSync(configPath);
    const configYmlExists = fs.existsSync(configYmlPath);

    if (configYamlExists || configYmlExists) {
      return 'exists';
    }

    // In non-interactive mode without --force, skip config creation
    if (!this.canPromptInteractively() && !this.force) {
      return 'skipped';
    }

    try {
      const yamlContent = serializeConfig({
        schema: DEFAULT_SCHEMA,
        context: DEFAULT_CONFIG_CONTEXT,
        rules: DEFAULT_CONFIG_RULES,
      });
      await FileSystemUtils.writeFile(configPath, yamlContent);
      return 'created';
    } catch {
      return 'skipped';
    }
  }

  private async createAgentsFile(projectPath: string): Promise<'created' | 'exists'> {
    const agentsPath = path.join(projectPath, 'AGENTS.md');

    if (fs.existsSync(agentsPath)) {
      return 'exists';
    }

    const content = `# AGENTS.md

本项目使用 InfraSpec 进行 Spec-Driven Development。

## Always

- 先理解任务、说清假设、暴露不确定性。
- 只做当前任务必须的最小修改。
- 匹配仓库现有风格，不顺手重构无关代码。
- 完成实现后运行 \`infraspec/build-check.sh\`，失败必须修复后重跑。
- 不要把未验证通过的任务标记为完成。

## Load Rules On Demand

先根据当前任务、代码图谱召回文件、待修改文件类型判断需要加载哪些规则：

- 编码、修 bug、重构前，读取 \`infraspec/agent-rules/coding-principles.md\`。
- 涉及 InfraSpec workflow 时，读取 \`infraspec/agent-rules/sdd.md\`。
- 涉及 Java、Spring、Maven、Gradle、\`.java\` 文件时，读取 \`infraspec/agent-rules/java-sonar.md\`。
- 涉及 React、Vue、JavaScript、TypeScript、CSS、前端构建时，读取 \`infraspec/agent-rules/frontend-lint.md\`。
- 执行校验、提交或标记任务完成前，读取 \`infraspec/agent-rules/verification.md\`。

不要默认一次性读取所有规则文件。只加载与当前任务和受影响文件相关的规则。

## 优先级

- 用户当前指令优先。
- 更靠近被修改文件的 \`AGENTS.md\` 优先。
- 仓库现有代码和项目约定优先。
- \`infraspec/agent-rules/\` 中的专项规则优先于通用建议。
- 本文件只做入口和路由，详细规则见 \`infraspec/agent-rules/\`。
`;

    await FileSystemUtils.writeFile(agentsPath, content);
    return 'created';
  }

  private async createAgentRules(projectPath: string): Promise<AgentRulesSetupStatus> {
    const rulesDir = path.join(projectPath, OPENSPEC_DIR_NAME, 'agent-rules');
    const directory: 'created' | 'exists' = fs.existsSync(rulesDir) ? 'exists' : 'created';
    await FileSystemUtils.createDirectory(rulesDir);

    const languageProfile = await this.detectProjectLanguageProfile(projectPath);
    const status: AgentRulesSetupStatus = {
      directory,
      index: await this.writeAgentRuleFileIfMissing(
        rulesDir,
        'index.md',
        this.getAgentRulesIndexTemplate(languageProfile)
      ),
      codingPrinciples: await this.writeAgentRuleFileIfMissing(
        rulesDir,
        'coding-principles.md',
        this.getCodingPrinciplesRuleTemplate()
      ),
      sdd: await this.writeAgentRuleFileIfMissing(rulesDir, 'sdd.md', this.getSddRuleTemplate()),
      verification: await this.writeAgentRuleFileIfMissing(
        rulesDir,
        'verification.md',
        this.getVerificationRuleTemplate()
      ),
    };

    if (languageProfile.java) {
      status.javaSonar = await this.writeAgentRuleFileIfMissing(
        rulesDir,
        'java-sonar.md',
        this.getJavaSonarRuleTemplate()
      );
    }

    if (languageProfile.frontend) {
      status.frontendLint = await this.writeAgentRuleFileIfMissing(
        rulesDir,
        'frontend-lint.md',
        this.getFrontendLintRuleTemplate()
      );
    }

    return status;
  }

  private async writeAgentRuleFileIfMissing(
    rulesDir: string,
    fileName: string,
    content: string
  ): Promise<'created' | 'exists'> {
    const filePath = path.join(rulesDir, fileName);
    if (fs.existsSync(filePath)) {
      return 'exists';
    }
    await FileSystemUtils.writeFile(filePath, content);
    return 'created';
  }

  private async detectProjectLanguageProfile(projectPath: string): Promise<ProjectLanguageProfile> {
    const java = await this.detectJavaProject(projectPath);
    const frontend = await this.detectFrontendProject(projectPath);
    return { java, frontend };
  }

  private async detectJavaProject(projectPath: string): Promise<boolean> {
    const javaMarkers = [
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
      path.join('src', 'main', 'java'),
    ];

    if (javaMarkers.some((marker) => fs.existsSync(path.join(projectPath, marker)))) {
      return true;
    }

    return this.hasFileWithExtensions(projectPath, ['.java']);
  }

  private async detectFrontendProject(projectPath: string): Promise<boolean> {
    const frontendMarkers = [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.json',
      'vite.config.js',
      'vite.config.ts',
      'next.config.js',
      'next.config.mjs',
      'nuxt.config.js',
      'nuxt.config.ts',
    ];

    if (frontendMarkers.some((marker) => fs.existsSync(path.join(projectPath, marker)))) {
      return true;
    }

    if (await this.packageJsonLooksFrontend(projectPath)) {
      return true;
    }

    return this.hasFileWithExtensions(projectPath, ['.tsx', '.jsx', '.vue', '.svelte']);
  }

  private async packageJsonLooksFrontend(projectPath: string): Promise<boolean> {
    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return false;
    }

    try {
      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf-8')) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };
      const depNames = Object.keys(deps);
      const frontendDeps = [
        'react',
        'react-dom',
        'vue',
        '@vue/runtime-dom',
        '@angular/core',
        'svelte',
        'next',
        'nuxt',
        'vite',
        'webpack',
        'eslint',
        'typescript',
      ];

      return frontendDeps.some((dep) => depNames.includes(dep))
        || Object.keys(packageJson.scripts ?? {}).some((scriptName) => scriptName === 'lint');
    } catch {
      return false;
    }
  }

  private async hasFileWithExtensions(
    projectPath: string,
    extensions: string[],
    maxFiles = 2000
  ): Promise<boolean> {
    const ignoredDirectories = new Set([
      '.git',
      '.idea',
      '.vscode',
      'node_modules',
      'target',
      'dist',
      'build',
      'coverage',
      OPENSPEC_DIR_NAME,
    ]);
    let checkedFiles = 0;

    const visit = async (dir: string): Promise<boolean> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return false;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (ignoredDirectories.has(entry.name)) {
            continue;
          }
          if (await visit(path.join(dir, entry.name))) {
            return true;
          }
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        checkedFiles += 1;
        if (extensions.includes(path.extname(entry.name))) {
          return true;
        }
        if (checkedFiles >= maxFiles) {
          return false;
        }
      }

      return false;
    };

    return visit(projectPath);
  }

  private getAgentRulesIndexTemplate(languageProfile: ProjectLanguageProfile): string {
    const enabledRules = [
      '- `coding-principles.md`: General coding principles for thinking, simplicity, surgical edits, and verification.',
      '- `sdd.md`: InfraSpec SDD workflow rules.',
      '- `verification.md`: Build, test, and completion verification rules.',
      ...(languageProfile.java ? ['- `java-sonar.md`: Java/Spring/Sonar quality rules.'] : []),
      ...(languageProfile.frontend ? ['- `frontend-lint.md`: Frontend lint and build quality rules.'] : []),
    ].join('\n');

    return `# Agent Rules Index

本目录保存 InfraSpec 的按需加载规则。根目录 \`AGENTS.md\` 只做入口和路由，不承载完整规范。

## Enabled Rules

${enabledRules}

## Language Detection

如果项目包含以下特征，按需加载对应规则：

- Java: \`pom.xml\`、\`build.gradle\`、\`src/main/java/\`、\`.java\`
- Frontend: \`package.json\`、\`eslint.config.*\`、\`.eslintrc*\`、\`.tsx\`、\`.jsx\`、\`.vue\`
- InfraSpec: \`infraspec/changes/\`、\`requirements.md\`、\`design.md\`、\`tasks.md\`

## Rule Loading

- 编码、修 bug、重构前读取 \`coding-principles.md\`。
- 修改 Java 代码前读取 \`java-sonar.md\`。
- 修改前端代码前读取 \`frontend-lint.md\`。
- 生成或执行 SDD artifact 前读取 \`sdd.md\`。
- 完成任务、提交代码、更新 checkbox 前读取 \`verification.md\`。
- 不要默认一次性读取所有规则文件。
`;
  }

  private getCodingPrinciplesRuleTemplate(): string {
    return `# Coding Principles

## 1. 编码前先思考

不要假设。不要隐藏困惑。把权衡摆出来。

实现之前：

- 明确说出你的假设。如果不确定，就问。
- 如果存在多种理解方式，列出来。
- 如果有更简单的方案，说出来。
- 如果有什么不清楚，停下来。说明哪里困惑。

## 2. 简单优先

能解决问题的最少代码。不要投机性功能。

- 不要加没被要求的功能。
- 单次使用的代码不要搞抽象。
- 不要加没被要求的“灵活性”。
- 不要为不可能的场景写错误处理。
- 如果 200 行能缩成 50 行，就重写。

## 3. 外科手术式修改

只改必须改的。只清理自己弄乱的。

- 不要“改进”相邻的代码或格式。
- 不要重构没坏的东西。
- 匹配现有风格，即使你不喜欢。
- 如果发现死代码，提一句，但别删。

## 4. 目标驱动执行

定义成功标准。循环直到验证通过。

- “加个验证”意味着写测试，然后让测试通过。
- “修这个 bug”意味着用测试复现，然后修复。
- “重构 X”意味着确保重构前后测试都通过。
`;
  }

  private getSddRuleTemplate(): string {
    return `# InfraSpec SDD Rules

适用于 \`infra-new\`、\`infra-review\`、\`infra-apply\`、\`infra-verify\` 等 InfraSpec workflow。

## Core Rules

- 需求、设计、任务和代码上下文必须围绕同一个 change。
- 生成 artifact 前先读取当前 change 已有文件，避免覆盖人工补充。
- 生成 \`requirements.md\` 前优先参考 \`code-context.md\`。
- 生成 \`detailed-design.md\`、\`design.md\`、\`tasks.md\` 前重新确认代码上下文是否存在。
- \`tasks.md\` 中的 checkbox 是实现进度跟踪器，只有验证通过后才能标记完成。

## Artifact Source Of Truth

- 当前变更事实来源位于 \`infraspec/changes/<change>/\`。
- 全局稳定规范位于 \`infraspec/specs/\`。
- 代码知识图谱摘要优先读 \`code-context.md\`，不要默认读取完整 \`index.json\`。
`;
  }

  private getVerificationRuleTemplate(): string {
    return `# Verification Rules

适用于实现完成、更新任务状态、提交代码或向用户报告完成之前。

## Required

- 必须运行 \`infraspec/build-check.sh\`。
- 如果校验失败，必须修复问题并重新运行，直到通过或明确说明阻塞原因。
- 不要在编译、构建、测试失败时把任务标记为完成。
- 优先使用仓库已有的 Maven、Gradle、npm、pnpm、yarn、Go、Cargo 或 dotnet 校验命令。

## Recommended

- Java 项目如配置了 Sonar、Checkstyle、SpotBugs 或 Maven profile，优先运行项目已有质量检查。
- 前端项目如配置了 lint、typecheck、test，优先运行对应脚本。
- 报告结果时说明实际执行的命令和是否通过。
`;
  }

  private getJavaSonarRuleTemplate(): string {
    return `# Sonar Java 检查规则精简版（中文）

适用于 Java、Spring、Maven、Gradle 项目。修改 \`.java\`、\`pom.xml\`、\`build.gradle\` 或相关配置时必须参考。

## 阻断

- 使用 \`@SessionAttributes\` 的 \`@Controller\` 类必须在其 \`SessionStatus\` 对象上调用 \`setComplete\`。
- \`@SpringBootApplication\` 和 \`@ComponentScan\` 不应在默认包中使用。
- \`PreparedStatement\` 和 \`ResultSet\` 方法应使用有效索引调用。
- 持有多个锁时不应调用 \`wait\`。
- 持有锁时应使用 \`wait(...)\`，而不是 \`Thread.sleep(...)\`。
- 不应使用双重检查锁定。
- 循环不应是无限循环。
- 不应在 \`Thread\` 实例上调用 \`wait(...)\`、\`notify()\` 和 \`notifyAll()\` 方法。
- 方法不应调用同类中 \`@Transactional\` 值不兼容的方法。
- printf 风格的格式字符串不应在运行时导致意外行为。
- 资源应被关闭。
- \`HostnameVerifier.verify\` 不应总是返回 true。
- 凭据不应硬编码。
- 加密密钥长度不应过短。
- 默认 EJB 拦截器应在 \`ejb-jar.xml\` 中声明。
- 应禁用 LDAP 反序列化。
- 不应使用 DES（数据加密标准）或 DESede（3DES）。
- 不应重写 \`clone\`。
- \`switch\` 语句不应包含非 case 标签。
- 断言应完整。
- 子类字段不应遮蔽父类字段。
- 未来关键字不应用作名称。
- JUnit 框架方法应正确声明。
- JUnit 测试用例应调用父类方法。
- 方法名和字段名不应相同，也不应仅大小写不同。
- 方法返回值不应保持不变。
- 布尔上下文中应使用短路逻辑。
- 不应执行无意义的位运算。
- \`switch\` 分支应以无条件 \`break\` 语句结束。
- TestCase 应包含测试。

## 严重

- 不应调用 \`runFinalizersOnExit\`。
- \`ScheduledThreadPoolExecutor\` 不应有 0 个核心线程。
- 在 \`Object.finalize()\` 实现的末尾应调用 \`super.finalize()\`。
- 依赖不应使用 \`system\` 作用域。
- Getter 和 setter 应访问预期字段。
- 锁应被释放。
- \`finalize()\` 的签名应与 \`Object.finalize()\` 匹配。
- 分母不应可能为零。
- 不应使用 \`File.createTempFile\` 创建目录。
- 不应使用 \`HttpServletRequest.getRequestedSessionId()\`。
- \`SecureRandom\` 的种子不应可预测。
- AES 加密算法应使用安全模式。
- 加密 RSA 算法应始终使用 OAEP（最优非对称加密填充）。
- 已定义的过滤器应被使用。
- LDAP 连接应进行认证。
- 持久化实体不应用作 \`@RequestMapping\` 方法的参数。
- SMTP SSL 连接应校验服务器身份。
- 应使用 SQL 绑定机制。
- Web 应用不应包含 \`main\` 方法。
- XML 转换器应加固安全配置。
- \`Cloneable\` 类应实现 \`clone\`。
- \`default\` 子句应位于最后。
- \`equals\` 方法参数不应标记为 \`@Nonnull\`。
- \`for\` 循环的增量子句应修改循环计数器。
- \`indexOf\` 检查不应只判断正数。
- 重写 \`Object.finalize()\` 时应保持 protected，而不是 public。
- \`Object.wait(...)\` 和 \`Condition.await(...)\` 应在 \`while\` 循环中调用。
- \`readResolve\` 方法应可被继承。
- \`switch\` 语句应包含 \`default\` 子句。
- 条件执行的单行代码应通过缩进明确表示。
- 类名不应遮蔽接口或父类。
- 类在初始化期间不应访问自身子类。
- 方法的认知复杂度不应过高。
- 条件语句应另起新行。
- 常量名应符合命名规范。
- 不应在接口中定义常量。
- 不应在 finally 块中抛出异常。
- 垃圾回收应仅由 JVM 触发。
- 在 \`@Configuration\` 类中应使用工厂方法注入。
- \`Serializable\` 类中的字段应为 transient 或可序列化。
- 泛型通配符类型不应用作返回参数。
- 不应捕获 \`IllegalMonitorStateException\`。
- 实例方法不应写入 \`static\` 字段。
- JUnit 断言不应在 \`run\` 方法中使用。
- 方法重写不应改变契约。
- 方法不应为空。
- \`Boolean\` 方法不应返回 null。
- 包声明应与源文件目录匹配。
- 字符串字面量不应重复。
- 从偏移量查找子字符串时应优先使用基于字符串偏移量的方法。
- 不应重写 \`Object.finalize()\` 方法。
- 应使用 try-with-resources。

## 主要

- 不应使用 \`.equals()\` 测试 \`Atomic\` 类的值。
- 不应使用 \`=+\` 代替 \`+=\`。
- 不应使用 \`BigDecimal(double)\`。
- 不应重载 \`compareTo\`。
- \`DefaultMessageListenerContainer\` 实例不应在重启期间丢弃消息。
- 不应将 \`Double.longBitsToDouble\` 用于 \`int\`。
- 重写 \`equals\` 方法时应接收 \`Object\` 参数。
- \`Externalizable\` 类应有无参构造函数。

## Agent Checklist

- 是否引入资源泄露、SQL 注入、硬编码密钥、弱加密。
- 是否违反事务、锁、并发、异常处理规则。
- 是否违反包路径、命名、复杂度、异常处理和测试规则。
- 是否能通过 \`infraspec/build-check.sh\`。
- 如果项目配置了 Sonar、Checkstyle、SpotBugs、Maven profile 或 Gradle quality task，优先运行项目已有校验命令。
`;
  }

  private getFrontendLintRuleTemplate(): string {
    return `# Frontend Lint Rules

适用于 React、Vue、JavaScript、TypeScript、CSS 和前端构建相关修改。

## Required

- 优先遵循项目已有 ESLint、Prettier、TypeScript、Stylelint 和组件库规范。
- 不要绕过 lint 规则，例如随意添加 \`eslint-disable\`、\`ts-ignore\` 或宽泛的 \`any\`。
- 修改 UI 代码后，优先运行项目已有的 \`lint\`、\`typecheck\`、\`test\`、\`build\` 脚本。
- React/Vue 组件应保持状态边界清晰，避免把业务副作用散落在渲染逻辑里。
- 用户可见文案、表单校验、错误状态和加载状态应保持一致。

## ESLint 中文规则

### Possible Errors

- 禁止条件表达式中出现模棱两可的赋值操作符。
- 禁用 console。
- 禁止在条件中使用常量表达式。
- 禁用 debugger。
- 禁止 function 定义中出现重名参数。
- 禁止对象字面量中出现重复的 key。
- 禁止出现重复的 case 标签。
- 禁止出现空语句块。
- 禁止对 catch 子句的参数重新赋值。
- 禁止不必要的布尔转换。
- 禁止不必要的括号。
- 禁止不必要的分号。
- 禁止对 function 声明重新赋值。
- 禁止在嵌套的块中出现变量声明或 function 声明。
- 禁止在字符串和注释之外不规则的空白。
- 禁止把全局对象作为函数调用。
- 禁用稀疏数组。
- 禁止直接使用 Object.prototypes 的内置属性。
- 禁止出现令人困惑的多行表达式。
- 禁止在 return、throw、continue 和 break 语句之后出现不可达代码。
- 要求使用 isNaN() 检查 NaN。
- 强制 typeof 表达式与有效的字符串进行比较。

### Best Practices

- 强制数组方法的回调函数中有 return 语句。
- 强制把变量的使用限制在其定义的作用域范围内。
- 指定程序中允许的最大环路复杂度。
- 要求 return 语句要么总是指定返回的值，要么不指定。
- 强制所有控制语句使用一致的括号风格。
- 要求 switch 语句中有 default 分支。
- 强制在点号之前和之后一致的换行。
- 强制在任何允许的时候使用点号。
- 要求使用 === 和 !==。
- 要求 for-in 循环中有一个 if 语句。
- 禁用 alert、confirm 和 prompt。
- 不允许在 case 子句中使用词法声明。
- 禁止 if 语句中有 return 之后有 else。
- 禁止出现空函数。
- 禁止在没有类型检查操作符的情况下与 null 进行比较。
- 禁用 eval()。
- 禁止不必要的 .bind() 调用。
- 禁止 case 语句落空。
- 禁止数字字面量中使用前导和末尾小数点。
- 禁止使用短符号进行类型转换。
- 禁止在全局范围内使用 var 和命名的 function 声明。
- 禁止 this 关键字出现在类和类对象之外。
- 禁用不必要的嵌套块。
- 禁止在循环中出现 function 声明和表达式。
- 禁用魔术数字。
- 禁止使用多个空格。
- 禁止使用多行字符串。
- 禁止在非赋值或条件语句中使用 new 操作符。
- 禁止对 Function 对象使用 new 操作符。
- 禁止对 String、Number 和 Boolean 使用 new 操作符。
- 不允许对 function 的参数进行重新赋值。
- 禁止使用 var 多次声明同一变量。
- 禁止在 return 语句中使用赋值语句。
- 禁止使用 javascript: url。
- 禁止自我赋值。
- 禁止自身比较。
- 禁用逗号操作符。
- 禁用一成不变的循环条件。
- 禁止出现未使用过的表达式。
- 禁止不必要的 .call() 和 .apply()。
- 禁止不必要的字符串字面量或模板字面量的连接。
- 要求所有的 var 声明出现在它们所在的作用域顶部。

### Strict Mode

- 要求或禁止使用严格模式指令。

### Variables

- 要求或禁止 var 声明中的初始化。
- 不允许 catch 子句的参数与外层作用域中的变量同名。
- 禁用特定的全局变量。
- 禁止 var 声明与外层作用域的变量同名。
- 禁用未声明的变量，除非它们在 global 注释中被提到。
- 禁止将变量初始化为 undefined。
- 禁止出现未使用过的变量。
- 不允许在变量定义之前使用它们。

### Node.js / CommonJS

- 要求 require() 出现在顶层模块作用域中。
- 要求回调函数中有容错处理。
- 禁止混合常规 var 声明和 require 调用。
- 禁止调用 require 时使用 new 操作符。
- 禁止对 dirname 和 filename 进行字符串连接。
- 禁用指定的通过 require 加载的模块。

### Style Guide

- 强制数组方括号中使用一致的空格。
- 强制在单行代码块中使用一致的空格。
- 强制在代码块中使用一致的大括号风格。
- 强制使用骆驼拼写法命名约定。
- 强制在逗号前后使用一致的空格。
- 强制使用一致的逗号风格。
- 强制在计算的属性的方括号中使用一致的空格。
- 强制文件末尾至少保留一行空行。
- 强制使用命名的 function 表达式。
- 强制一致地使用函数声明或函数表达式。
- 强制使用一致的缩进。
- 强制在 JSX 属性中一致地使用双引号或单引号。
- 强制在对象字面量的属性中键和值之间使用一致的间距。
- 强制在关键字前后使用一致的空格。
- 强制使用一致的换行风格。
- 要求在注释周围有空行。
- 强制可嵌套的块的最大深度。
- 强制一行的最大长度。
- 强制最大行数。
- 强制回调函数最大嵌套深度。
- 强制 function 定义中最多允许的参数数量。
- 强制 function 块最多允许的语句数量。
- 强制每一行中所允许的最大语句数量。
- 要求构造函数首字母大写。
- 要求调用无参构造函数时有圆括号。
- 要求或禁止 var 声明语句后有一行空行。
- 要求 return 语句之前有一空行。
- 要求方法链中每个调用都有一个换行符。
- 禁止使用 Array 构造函数。
- 禁用 continue 语句。
- 禁止在代码行后使用内联注释。
- 禁止 if 作为唯一的语句出现在 else 语句中。
- 不允许空格和 tab 混合缩进。
- 不允许多个空行。
- 不允许否定的表达式。
- 禁止使用一元操作符 ++ 和 --。
- 禁止 function 标识符和括号之间出现空格。
- 禁用行尾空格。
- 禁止属性前有空白。
- 强制花括号内换行符的一致性。
- 强制在花括号中使用一致的空格。
- 强制将对象的属性放在不同的行上。
- 强制函数中的变量要么一起声明要么分开声明。
- 要求或禁止在 var 声明周围换行。
- 要求或禁止在可能的情况下使用简化的赋值操作符。
- 强制操作符使用一致的换行符。
- 要求对象字面量属性名称用引号括起来。
- 强制使用一致的反勾号、双引号或单引号。
- 要求使用 JSDoc 注释。
- 要求或禁止使用分号而不是 ASI。
- 强制分号之前和之后使用一致的空格。
- 要求同一个声明块中的变量按顺序排列。
- 强制在块之前使用一致的空格。
- 强制在 function 的左括号之前使用一致的空格。
- 强制在圆括号内使用一致的空格。
- 要求操作符周围有空格。
- 强制在一元操作符前后使用一致的空格。
- 强制在注释中 // 或 /* 使用一致的空格。

## Agent Checklist

- 是否符合项目既有组件、路由、状态管理和请求封装模式。
- 是否引入未处理的异步错误、内存泄漏或重复请求。
- 是否影响移动端、可访问性、键盘操作或国际化。
- 是否能通过 \`infraspec/build-check.sh\` 和项目已有前端质量脚本。
`;
  }

  private async setupBuildVerification(
    projectPath: string,
    gitRepository: GitRepositorySetupStatus
  ): Promise<BuildVerificationSetupStatus> {
    const agents = await this.createAgentsFile(projectPath);
    const agentRules = await this.createAgentRules(projectPath);
    const preCommitHook = await this.createPreCommitHook(projectPath);
    const buildCheck = await this.createBuildCheckScript(projectPath);
    const hookInstall = await this.installProjectGitHook(projectPath);

    return { gitRepository, agents, agentRules, preCommitHook, buildCheck, hookInstall };
  }

  private hasGitMetadata(projectPath: string): boolean {
    return fs.existsSync(path.join(projectPath, '.git'));
  }

  private async isInsideParentGitRepository(projectPath: string): Promise<boolean> {
    try {
      const gitTopLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      return path.resolve(gitTopLevel) !== projectPath;
    } catch {
      return false;
    }
  }

  private async isNearNewProject(projectPath: string): Promise<boolean> {
    if (!fs.existsSync(projectPath)) {
      return true;
    }

    const entries = await fs.promises.readdir(projectPath).catch(() => []);
    const filteredEntries = entries.filter((entry) => entry !== '.DS_Store' && entry !== OPENSPEC_DIR_NAME);

    if (filteredEntries.length === 0) {
      return true;
    }

    const allowedEntries = new Set([
      '.editorconfig',
      '.env.example',
      '.gitignore',
      '.npmrc',
      '.nvmrc',
      '.prettierrc',
      '.prettierrc.json',
      '.tool-versions',
      'README',
      'README.md',
      'LICENSE',
      'LICENSE.md',
      'NOTICE',
      'app',
      'build.gradle',
      'build.gradle.kts',
      'Cargo.lock',
      'Cargo.toml',
      'cmd',
      'docs',
      'go.mod',
      'go.sum',
      'gradle',
      'gradle.properties',
      'gradlew',
      'gradlew.bat',
      'internal',
      'lib',
      'mvnw',
      'mvnw.cmd',
      'package-lock.json',
      'package.json',
      'pnpm-lock.yaml',
      'pom.xml',
      'settings.gradle',
      'settings.gradle.kts',
      'src',
      'test',
      'tests',
      'tsconfig.json',
      'tsconfig.base.json',
      'vite.config.ts',
      'vite.config.js',
      'yarn.lock',
      'bun.lock',
      'bun.lockb',
    ]);

    if (filteredEntries.length > 12) {
      return false;
    }

    return filteredEntries.every((entry) => allowedEntries.has(entry));
  }

  private async ensureGitRepository(projectPath: string): Promise<GitRepositorySetupStatus> {
    if (this.hasGitMetadata(projectPath)) {
      return 'existing';
    }

    if (await this.isInsideParentGitRepository(projectPath)) {
      return 'skipped-parent-repo';
    }

    if (!(await this.isNearNewProject(projectPath))) {
      return 'skipped-not-new';
    }

    try {
      await fs.promises.mkdir(projectPath, { recursive: true });
      execFileSync('git', ['init'], {
        cwd: projectPath,
        stdio: 'ignore',
      });
      return 'initialized';
    } catch {
      return 'failed';
    }
  }

  private async createPreCommitHook(projectPath: string): Promise<'created' | 'exists'> {
    const hookPath = path.join(projectPath, '.githooks', 'pre-commit');

    if (fs.existsSync(hookPath)) {
      return 'exists';
    }

    const content = `#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

INFRASPEC_BUILD_CHECK_ALLOW_MISSING_TOOLS=1 exec "$PROJECT_ROOT/${OPENSPEC_DIR_NAME}/build-check.sh"
`;

    await FileSystemUtils.writeFile(hookPath, content);
    await fs.promises.chmod(hookPath, 0o755);
    return 'created';
  }

  private async createBuildCheckScript(projectPath: string): Promise<'created' | 'exists'> {
    const scriptPath = path.join(projectPath, OPENSPEC_DIR_NAME, 'build-check.sh');

    if (fs.existsSync(scriptPath)) {
      return 'exists';
    }

    const content = `#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

has_command() {
  command -v "$1" >/dev/null 2>&1
}

allow_missing_tools() {
  case "\${INFRASPEC_BUILD_CHECK_ALLOW_MISSING_TOOLS:-0}" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

missing_tool() {
  reason="$1"
  if allow_missing_tools; then
    echo "Build verification skipped: $reason" >&2
    echo "Install the required build tool or run ${OPENSPEC_DIR_NAME}/build-check.sh from a configured shell before pushing." >&2
    exit 0
  fi

  echo "Build verification failed: $reason" >&2
  exit 1
}

run_cmd() {
  echo "Running build command: $*"
  "$@"
}

if [ -x "$PROJECT_ROOT/gradlew" ]; then
  cd "$PROJECT_ROOT"
  run_cmd ./gradlew classes
  exit 0
fi

if [ -f "$PROJECT_ROOT/pom.xml" ]; then
  cd "$PROJECT_ROOT"
  if [ -x "$PROJECT_ROOT/mvnw" ]; then
    run_cmd ./mvnw -q -DskipTests compile
    exit 0
  fi
  if has_command mvn; then
    run_cmd mvn -q -DskipTests compile
    exit 0
  fi
  missing_tool "Maven project detected but mvn/mvnw is unavailable."
fi

if [ -f "$PROJECT_ROOT/build.gradle" ] || [ -f "$PROJECT_ROOT/build.gradle.kts" ] || [ -f "$PROJECT_ROOT/settings.gradle" ] || [ -f "$PROJECT_ROOT/settings.gradle.kts" ]; then
  cd "$PROJECT_ROOT"
  if has_command gradle; then
    run_cmd gradle classes
    exit 0
  fi
  missing_tool "Gradle project detected but gradle/gradlew is unavailable."
fi

if [ -f "$PROJECT_ROOT/package.json" ]; then
  cd "$PROJECT_ROOT"
  if [ -f "$PROJECT_ROOT/pnpm-lock.yaml" ]; then
    if ! has_command pnpm; then
      missing_tool "pnpm-lock.yaml detected but pnpm is unavailable."
    fi
    run_cmd pnpm run build
    exit 0
  fi
  if [ -f "$PROJECT_ROOT/bun.lockb" ] || [ -f "$PROJECT_ROOT/bun.lock" ]; then
    if ! has_command bun; then
      missing_tool "Bun lockfile detected but bun is unavailable."
    fi
    run_cmd bun run build
    exit 0
  fi
  if [ -f "$PROJECT_ROOT/yarn.lock" ]; then
    if ! has_command yarn; then
      missing_tool "yarn.lock detected but yarn is unavailable."
    fi
    run_cmd yarn build
    exit 0
  fi
  if ! has_command npm; then
    missing_tool "package.json detected but npm is unavailable."
  fi
  run_cmd npm run build
  exit 0
fi

if [ -f "$PROJECT_ROOT/go.mod" ]; then
  cd "$PROJECT_ROOT"
  if ! has_command go; then
    missing_tool "go.mod detected but Go is unavailable."
  fi
  run_cmd go build ./...
  exit 0
fi

if [ -f "$PROJECT_ROOT/Cargo.toml" ]; then
  cd "$PROJECT_ROOT"
  if ! has_command cargo; then
    missing_tool "Cargo.toml detected but cargo is unavailable."
  fi
  run_cmd cargo check
  exit 0
fi

if find "$PROJECT_ROOT" -maxdepth 1 \\( -name '*.sln' -o -name '*.csproj' \\) | grep -q .; then
  cd "$PROJECT_ROOT"
  if ! has_command dotnet; then
    missing_tool ".NET project detected but dotnet is unavailable."
  fi
  run_cmd dotnet build
  exit 0
fi

if allow_missing_tools; then
  echo "Build verification skipped: unable to detect a supported build command automatically." >&2
  echo "Customize ${OPENSPEC_DIR_NAME}/build-check.sh to match your project's real build/compile command." >&2
  exit 0
fi

echo "Build verification failed: unable to detect a supported build command automatically." >&2
echo "Build verification command: <not detected automatically>" >&2
echo "Customize ${OPENSPEC_DIR_NAME}/build-check.sh to match your project's real build/compile command, then rerun it." >&2
exit 1
`;

    await FileSystemUtils.writeFile(scriptPath, content);
    await fs.promises.chmod(scriptPath, 0o755);
    return 'created';
  }

  private async installProjectGitHook(projectPath: string): Promise<GitHookInstallStatus> {
    if (!this.hasGitMetadata(projectPath)) {
      return 'skipped-no-git';
    }

    try {
      const currentHookPath = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (currentHookPath === '.githooks') {
        return 'already-configured';
      }

      if (currentHookPath.length > 0) {
        return 'skipped-existing-hooks';
      }
    } catch {
      // Missing config is expected; fall through and configure it.
    }

    try {
      execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
        cwd: projectPath,
        stdio: 'ignore',
      });
      return 'configured';
    } catch {
      return 'failed';
    }
  }

  // ═══════════════════════════════════════════════════════════
  // UI & OUTPUT
  // ═══════════════════════════════════════════════════════════

  private displaySuccessMessage(
    projectPath: string,
    tools: Array<{ value: string; name: string; skillsDir: string; wasConfigured: boolean }>,
    results: {
      createdTools: typeof tools;
      refreshedTools: typeof tools;
      failedTools: Array<{ name: string; error: Error }>;
      commandsSkipped: string[];
      removedCommandCount: number;
      removedSkillCount: number;
    },
    configStatus: 'created' | 'exists' | 'skipped',
    buildVerificationStatus: BuildVerificationSetupStatus
  ): void {
    console.log();
    console.log(chalk.bold('InfraSpec Setup Complete'));
    console.log();

    // Show created vs refreshed tools
    if (results.createdTools.length > 0) {
      console.log(`Created: ${results.createdTools.map((t) => t.name).join(', ')}`);
    }
    if (results.refreshedTools.length > 0) {
      console.log(`Refreshed: ${results.refreshedTools.map((t) => t.name).join(', ')}`);
    }

    // Show counts (respecting profile filter)
    const successfulTools = [...results.createdTools, ...results.refreshedTools];
    if (successfulTools.length > 0) {
      const globalConfig = getGlobalConfig();
      const profile: Profile = (this.profileOverride as Profile) ?? globalConfig.profile ?? 'core';
      const delivery: Delivery = globalConfig.delivery ?? 'both';
      const workflows = getProfileWorkflows(profile, globalConfig.workflows);
      const toolDirs = [...new Set(successfulTools.map((t) => t.skillsDir))].join(', ');
      const skillCount = delivery !== 'commands' ? getSkillTemplates(workflows).length : 0;
      const commandCount = delivery !== 'skills' ? getCommandContents(workflows).length : 0;
      if (skillCount > 0 && commandCount > 0) {
        console.log(`${skillCount} skills and ${commandCount} commands in ${toolDirs}/`);
      } else if (skillCount > 0) {
        console.log(`${skillCount} skills in ${toolDirs}/`);
      } else if (commandCount > 0) {
        console.log(`${commandCount} commands in ${toolDirs}/`);
      }
    }

    // Show failures
    if (results.failedTools.length > 0) {
      console.log(chalk.red(`Failed: ${results.failedTools.map((f) => `${f.name} (${f.error.message})`).join(', ')}`));
    }

    // Show skipped commands
    if (results.commandsSkipped.length > 0) {
      console.log(chalk.dim(`Commands skipped for: ${results.commandsSkipped.join(', ')} (no adapter)`));
    }
    if (results.removedCommandCount > 0) {
      console.log(chalk.dim(`Removed: ${results.removedCommandCount} command files (delivery: skills)`));
    }
    if (results.removedSkillCount > 0) {
      console.log(chalk.dim(`Removed: ${results.removedSkillCount} skill directories (delivery: commands)`));
    }

    // Config status
    if (configStatus === 'created') {
      console.log(`Config: infraspec/config.yaml (schema: ${DEFAULT_SCHEMA})`);
    } else if (configStatus === 'exists') {
      // Show actual filename (config.yaml or config.yml)
      const configYaml = path.join(projectPath, OPENSPEC_DIR_NAME, 'config.yaml');
      const configYml = path.join(projectPath, OPENSPEC_DIR_NAME, 'config.yml');
      const configName = fs.existsSync(configYaml) ? 'config.yaml' : fs.existsSync(configYml) ? 'config.yml' : 'config.yaml';
      console.log(`Config: infraspec/${configName} (exists)`);
    } else {
      console.log(chalk.dim(`Config: skipped (non-interactive mode)`));
    }

    if (buildVerificationStatus.agents === 'created') {
      console.log('AGENTS.md: created at project root');
    } else {
      console.log(chalk.dim('AGENTS.md: exists (skipped)'));
    }

    if (buildVerificationStatus.agentRules.directory === 'created') {
      console.log(`Agent rules: ${OPENSPEC_DIR_NAME}/agent-rules created`);
    } else {
      console.log(chalk.dim(`Agent rules: ${OPENSPEC_DIR_NAME}/agent-rules exists`));
    }

    if (buildVerificationStatus.gitRepository === 'initialized') {
      console.log('Git repository: initialized automatically');
    } else if (buildVerificationStatus.gitRepository === 'existing') {
      console.log(chalk.dim('Git repository: existing repository detected'));
    } else if (buildVerificationStatus.gitRepository === 'skipped-parent-repo') {
      console.log(chalk.dim('Git repository: not initialized (target is inside a larger Git repository)'));
    } else if (buildVerificationStatus.gitRepository === 'skipped-not-new') {
      console.log(chalk.dim('Git repository: not initialized (target does not look like an empty or near-new project)'));
    } else {
      console.log(chalk.yellow('Git repository: auto-initialization failed; initialize Git manually if needed.'));
    }

    if (buildVerificationStatus.preCommitHook === 'created') {
      console.log('Git hook: .githooks/pre-commit created');
    } else {
      console.log(chalk.dim('Git hook: .githooks/pre-commit exists (skipped)'));
    }

    if (buildVerificationStatus.buildCheck === 'created') {
      console.log(`Build verification: ${OPENSPEC_DIR_NAME}/build-check.sh created`);
    } else {
      console.log(chalk.dim(`Build verification: ${OPENSPEC_DIR_NAME}/build-check.sh exists (skipped)`));
    }

    if (buildVerificationStatus.hookInstall === 'configured') {
      console.log('Git hooks enabled: core.hooksPath -> .githooks');
    } else if (buildVerificationStatus.hookInstall === 'already-configured') {
      console.log(chalk.dim('Git hooks already enabled: core.hooksPath -> .githooks'));
    } else if (buildVerificationStatus.hookInstall === 'failed') {
      console.log(chalk.yellow('Git hooks not auto-enabled. Run `git config core.hooksPath .githooks` in this project.'));
    } else if (buildVerificationStatus.hookInstall === 'skipped-existing-hooks') {
      console.log(chalk.dim('Git hooks not auto-enabled (project already uses a custom core.hooksPath).'));
    } else {
      console.log(chalk.dim('Git hooks not auto-enabled (no Git repository detected).'));
    }

    // Getting started (task 7.6: show propose if in profile)
    const globalCfg = getGlobalConfig();
    const activeProfile: Profile = (this.profileOverride as Profile) ?? globalCfg.profile ?? 'core';
    const activeWorkflows = [...getProfileWorkflows(activeProfile, globalCfg.workflows)];
    console.log();
    if (activeWorkflows.includes('propose')) {
      console.log(chalk.bold('Getting started:'));
      console.log('  Start your first change: /infra:propose "your idea"');
    } else if (activeWorkflows.includes('new')) {
      console.log(chalk.bold('Getting started:'));
      console.log('  Start your first change: /infra:new "your idea"');
    } else {
      console.log("Done. Run 'infraspec config profile' to configure your workflows.");
    }

    // Restart instruction if any tools were configured
    if (results.createdTools.length > 0 || results.refreshedTools.length > 0) {
      console.log();
      console.log(chalk.white('Restart your IDE for slash commands to take effect.'));
    }

    console.log();
  }

  private startSpinner(text: string) {
    return ora({
      text,
      stream: process.stdout,
      color: 'gray',
      spinner: PROGRESS_SPINNER,
    }).start();
  }

  private async removeSkillDirs(skillsDir: string): Promise<number> {
    let removed = 0;

    for (const workflow of ALL_WORKFLOWS) {
      const dirName = WORKFLOW_TO_SKILL_DIR[workflow];
      if (!dirName) continue;

      const skillDir = path.join(skillsDir, dirName);
      try {
        if (fs.existsSync(skillDir)) {
          await fs.promises.rm(skillDir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // Ignore errors
      }
    }

    return removed;
  }

  private async removeCommandFiles(projectPath: string, toolId: string): Promise<number> {
    let removed = 0;
    const adapter = CommandAdapterRegistry.get(toolId);
    if (!adapter) return 0;

    for (const workflow of ALL_WORKFLOWS) {
      const cmdPath = adapter.getFilePath(workflow);
      const fullPath = path.isAbsolute(cmdPath) ? cmdPath : path.join(projectPath, cmdPath);

      try {
        if (fs.existsSync(fullPath)) {
          await fs.promises.unlink(fullPath);
          removed++;
        }
      } catch {
        // Ignore errors
      }
    }

    return removed;
  }
}
