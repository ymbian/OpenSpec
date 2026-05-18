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
  preCommitHook: 'created' | 'exists';
  buildCheck: 'created' | 'exists';
  hookInstall: GitHookInstallStatus;
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

本项目使用 InfraSpec 来规划和实现变更。

## InfraSpec 工作流

- 将 \`proposal.md\`、\`specs/\`、\`design.md\` 和 \`tasks.md\` 作为当前变更的事实来源。
- 将 \`tasks.md\` 中的 checkbox 视为实现进度跟踪器。

## 编辑规则

- 如果这是一个空的新项目，默认将生成的应用代码和项目内配置放在 \`src/\` 目录下；只有工具链明确要求时，才放在项目根目录。
- 完成本次变更或本次编码会话的实现后，必须执行项目标准的编译/构建校验，并确保通过后才能报告实现完成。
- 如果编译或构建失败，必须先修复问题并重新验证通过，再更新完成状态或提交代码。
- 本项目默认使用 \`infraspec/build-check.sh\` 作为统一的构建校验入口；如需调整，请在保留“提交前必须通过编译/构建”的前提下修改该脚本。
- 优先遵循仓库中已有的项目规范。

## 优先级

- 仓库现有代码和项目约定优先。
- 本文件只是初始模板，项目团队可以按需修改。
`;

    await FileSystemUtils.writeFile(agentsPath, content);
    return 'created';
  }

  private async setupBuildVerification(
    projectPath: string,
    gitRepository: GitRepositorySetupStatus
  ): Promise<BuildVerificationSetupStatus> {
    const agents = await this.createAgentsFile(projectPath);
    const preCommitHook = await this.createPreCommitHook(projectPath);
    const buildCheck = await this.createBuildCheckScript(projectPath);
    const hookInstall = await this.installProjectGitHook(projectPath);

    return { gitRepository, agents, preCommitHook, buildCheck, hookInstall };
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

exec "$PROJECT_ROOT/${OPENSPEC_DIR_NAME}/build-check.sh"
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
  echo "Build verification failed: Maven project detected but mvn/mvnw is unavailable." >&2
  exit 1
fi

if [ -f "$PROJECT_ROOT/build.gradle" ] || [ -f "$PROJECT_ROOT/build.gradle.kts" ] || [ -f "$PROJECT_ROOT/settings.gradle" ] || [ -f "$PROJECT_ROOT/settings.gradle.kts" ]; then
  cd "$PROJECT_ROOT"
  if has_command gradle; then
    run_cmd gradle classes
    exit 0
  fi
  echo "Build verification failed: Gradle project detected but gradle/gradlew is unavailable." >&2
  exit 1
fi

if [ -f "$PROJECT_ROOT/package.json" ]; then
  cd "$PROJECT_ROOT"
  if [ -f "$PROJECT_ROOT/pnpm-lock.yaml" ]; then
    if ! has_command pnpm; then
      echo "Build verification failed: pnpm-lock.yaml detected but pnpm is unavailable." >&2
      exit 1
    fi
    run_cmd pnpm run build
    exit 0
  fi
  if [ -f "$PROJECT_ROOT/bun.lockb" ] || [ -f "$PROJECT_ROOT/bun.lock" ]; then
    if ! has_command bun; then
      echo "Build verification failed: Bun lockfile detected but bun is unavailable." >&2
      exit 1
    fi
    run_cmd bun run build
    exit 0
  fi
  if [ -f "$PROJECT_ROOT/yarn.lock" ]; then
    if ! has_command yarn; then
      echo "Build verification failed: yarn.lock detected but yarn is unavailable." >&2
      exit 1
    fi
    run_cmd yarn build
    exit 0
  fi
  if ! has_command npm; then
    echo "Build verification failed: package.json detected but npm is unavailable." >&2
    exit 1
  fi
  run_cmd npm run build
  exit 0
fi

if [ -f "$PROJECT_ROOT/go.mod" ]; then
  cd "$PROJECT_ROOT"
  if ! has_command go; then
    echo "Build verification failed: go.mod detected but Go is unavailable." >&2
    exit 1
  fi
  run_cmd go build ./...
  exit 0
fi

if [ -f "$PROJECT_ROOT/Cargo.toml" ]; then
  cd "$PROJECT_ROOT"
  if ! has_command cargo; then
    echo "Build verification failed: Cargo.toml detected but cargo is unavailable." >&2
    exit 1
  fi
  run_cmd cargo check
  exit 0
fi

if find "$PROJECT_ROOT" -maxdepth 1 \\( -name '*.sln' -o -name '*.csproj' \\) | grep -q .; then
  cd "$PROJECT_ROOT"
  if ! has_command dotnet; then
    echo "Build verification failed: .NET project detected but dotnet is unavailable." >&2
    exit 1
  fi
  run_cmd dotnet build
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
