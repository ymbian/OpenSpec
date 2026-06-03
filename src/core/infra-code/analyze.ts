import path from 'path';
import { promises as fs } from 'fs';
import { validateChangeExists } from '../../commands/workflow/shared.js';
import { buildCodeContext, formatCodeContextMarkdown } from './context.js';
import { buildInfraCodeIndex, writeInfraCodeIndex } from './indexer.js';

const REQUIREMENT_DESCRIPTION_FILE = 'requirement-description.md';
const CODE_CONTEXT_FILE = 'code-context.md';
const CODE_CONTEXT_JSON_FILE = '.code-context.json';

export interface AnalyzeCodeOptions {
  change: string;
  projectRoot?: string;
  maxNodes?: number;
  maxCodeBlocks?: number;
}

export interface AnalyzeCodeResult {
  changeName: string;
  changeDir: string;
  requirementPath: string;
  contextPath: string;
  contextJsonPath: string;
  status: 'ready' | 'unavailable';
  backend?: 'json';
  stats?: Record<string, unknown>;
  message: string;
  error?: string;
}

export interface IndexCodeOptions {
  projectRoot?: string;
}

export interface IndexCodeResult {
  indexPath: string;
  status: 'ready';
  backend: 'json';
  stats: Record<string, unknown>;
  message: string;
}

function getChangeDir(projectRoot: string, changeName: string): string {
  return path.join(projectRoot, 'infraspec', 'changes', changeName);
}

async function readRequirementDescription(requirementPath: string): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(requirementPath, 'utf-8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Missing ${REQUIREMENT_DESCRIPTION_FILE}. Expected ${requirementPath}. ${reason}`
    );
  }

  if (content.trim().length === 0) {
    throw new Error(`${REQUIREMENT_DESCRIPTION_FILE} is empty: ${requirementPath}`);
  }

  return content;
}

async function writeUnavailableContext(
  paths: {
    requirementPath: string;
    contextPath: string;
    contextJsonPath: string;
  },
  error: unknown
): Promise<Pick<AnalyzeCodeResult, 'status' | 'message' | 'error'>> {
  const reason = error instanceof Error ? error.message : String(error);
  const markdown = [
    '# Code Context',
    '',
    `Requirement source: \`${paths.requirementPath}\``,
    '',
    'Code graph analysis is unavailable for this run.',
    '',
    'InfraSpec can still create `requirements.md`; fill code-backed sections from the user requirement and any files you inspect manually.',
    '',
    '## Error',
    '',
    '```text',
    reason,
    '```',
    '',
  ].join('\n');

  const json = {
    status: 'unavailable',
    requirementPath: paths.requirementPath,
    generatedAt: new Date().toISOString(),
    error: reason,
  };

  await fs.writeFile(paths.contextPath, markdown, 'utf-8');
  await fs.writeFile(paths.contextJsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');

  return {
    status: 'unavailable',
    message: 'Code graph analysis unavailable; wrote fallback code-context files.',
    error: reason,
  };
}

export async function analyzeCodeForChange(options: AnalyzeCodeOptions): Promise<AnalyzeCodeResult> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const changeName = await validateChangeExists(options.change, projectRoot);
  const changeDir = getChangeDir(projectRoot, changeName);
  const requirementPath = path.join(changeDir, REQUIREMENT_DESCRIPTION_FILE);
  const contextPath = path.join(changeDir, CODE_CONTEXT_FILE);
  const contextJsonPath = path.join(changeDir, CODE_CONTEXT_JSON_FILE);

  const requirementText = await readRequirementDescription(requirementPath);

  try {
    const index = await buildInfraCodeIndex(projectRoot);
    const indexPath = await writeInfraCodeIndex(projectRoot, index);
    const context = await buildCodeContext(projectRoot, index, requirementText, {
      maxNodes: options.maxNodes ?? 30,
      maxCodeBlocks: options.maxCodeBlocks ?? 8,
    });
    const markdown = formatCodeContextMarkdown(context, requirementPath, indexPath);
    const payload = {
      status: 'ready',
      changeName,
      requirementPath,
      indexPath,
      generatedAt: new Date().toISOString(),
      backend: 'json',
      context,
    };

    await fs.writeFile(contextPath, markdown, 'utf-8');
    await fs.writeFile(contextJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');

    return {
      changeName,
      changeDir,
      requirementPath,
      contextPath,
      contextJsonPath,
      status: 'ready',
      backend: 'json',
      stats: context.stats,
      message: `Generated ${CODE_CONTEXT_FILE} from built-in code graph context.`,
    };
  } catch (error) {
    const fallback = await writeUnavailableContext({
      requirementPath,
      contextPath,
      contextJsonPath,
    }, error);

    return {
      changeName,
      changeDir,
      requirementPath,
      contextPath,
      contextJsonPath,
      ...fallback,
    };
  }
}

export async function indexProjectCode(options: IndexCodeOptions = {}): Promise<IndexCodeResult> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const index = await buildInfraCodeIndex(projectRoot);
  const indexPath = await writeInfraCodeIndex(projectRoot, index);

  return {
    indexPath,
    status: 'ready',
    backend: 'json',
    stats: index.stats,
    message: 'Generated global code graph index from current source code.',
  };
}
