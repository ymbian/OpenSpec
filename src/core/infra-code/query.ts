import path from 'node:path';
import {
  buildInfraCodeIndex,
  getInfraCodeIndexPath,
  readInfraCodeIndex,
  writeInfraCodeIndex,
} from './indexer.js';
import type {
  CodeEdge,
  CodeEntryPoint,
  CodeExecutionFlow,
  CodeFile,
  CodeModule,
  CodeSymbol,
  InfraCodeIndex,
} from './types.js';

export interface CodeGraphQueryOptions {
  projectRoot?: string;
  refresh?: boolean;
}

export interface CodeModuleDetailOptions extends CodeGraphQueryOptions {
  moduleId: string;
  maxFiles?: number;
  maxSymbols?: number;
  maxFlows?: number;
  maxEdges?: number;
}

export interface CodeModuleSummary {
  id: string;
  name: string;
  strategy: CodeModule['strategy'];
  confidence: CodeModule['confidence'];
  rootPaths: string[];
  layers: string[];
  languages: CodeModule['languages'];
  terms: string[];
  fileCount: number;
  symbolCount: number;
  entryPointCount: number;
  executionFlowCount: number;
  sampleFiles: string[];
}

export interface CodeModulesResult {
  indexPath: string;
  indexGenerated: boolean;
  generatedAt: string;
  stats: InfraCodeIndex['stats'];
  modules: CodeModuleSummary[];
}

export interface CodeModuleDetailResult {
  indexPath: string;
  indexGenerated: boolean;
  generatedAt: string;
  module: CodeModule;
  totals: {
    files: number;
    symbols: number;
    entryPoints: number;
    executionFlows: number;
    edges: number;
  };
  truncated: {
    files: boolean;
    symbols: boolean;
    executionFlows: boolean;
    edges: boolean;
  };
  files: Array<Pick<CodeFile, 'id' | 'path' | 'language' | 'hash' | 'lineCount' | 'terms'>>;
  symbols: Array<Pick<CodeSymbol, 'id' | 'name' | 'kind' | 'filePath' | 'language' | 'startLine' | 'endLine' | 'signature' | 'terms'>>;
  entryPoints: CodeEntryPoint[];
  executionFlows: CodeExecutionFlow[];
  edges: CodeEdge[];
}

const DEFAULT_MAX_FILES = 80;
const DEFAULT_MAX_SYMBOLS = 160;
const DEFAULT_MAX_FLOWS = 20;
const DEFAULT_MAX_EDGES = 240;

async function ensureInfraCodeIndex(options: CodeGraphQueryOptions = {}): Promise<{
  index: InfraCodeIndex;
  indexPath: string;
  indexGenerated: boolean;
}> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const indexPath = getInfraCodeIndexPath(projectRoot);

  if (options.refresh) {
    const index = await buildInfraCodeIndex(projectRoot);
    await writeInfraCodeIndex(projectRoot, index);
    return { index, indexPath, indexGenerated: true };
  }

  try {
    const index = await readInfraCodeIndex(projectRoot);
    return { index, indexPath, indexGenerated: false };
  } catch {
    const index = await buildInfraCodeIndex(projectRoot);
    await writeInfraCodeIndex(projectRoot, index);
    return { index, indexPath, indexGenerated: true };
  }
}

function summarizeModule(
  module: CodeModule,
  entryPoints: CodeEntryPoint[],
  executionFlows: CodeExecutionFlow[]
): CodeModuleSummary {
  return {
    id: module.id,
    name: module.name,
    strategy: module.strategy,
    confidence: module.confidence,
    rootPaths: module.rootPaths,
    layers: module.layers,
    languages: module.languages,
    terms: module.terms.slice(0, 16),
    fileCount: module.fileCount,
    symbolCount: module.symbolCount,
    entryPointCount: entryPoints.filter((entry) => entry.moduleId === module.id).length,
    executionFlowCount: executionFlows.filter((flow) => flow.moduleIds.includes(module.id)).length,
    sampleFiles: module.files.slice(0, 8),
  };
}

export async function listCodeModules(options: CodeGraphQueryOptions = {}): Promise<CodeModulesResult> {
  const { index, indexPath, indexGenerated } = await ensureInfraCodeIndex(options);

  return {
    indexPath,
    indexGenerated,
    generatedAt: index.generatedAt,
    stats: index.stats,
    modules: index.modules.map((module) => summarizeModule(module, index.entryPoints, index.executionFlows)),
  };
}

export async function getCodeModuleDetail(options: CodeModuleDetailOptions): Promise<CodeModuleDetailResult> {
  const {
    index,
    indexPath,
    indexGenerated,
  } = await ensureInfraCodeIndex(options);
  const module = index.modules.find((item) => item.id === options.moduleId);
  if (!module) {
    const available = index.modules.slice(0, 20).map((item) => item.id).join(', ');
    throw new Error(`Code module '${options.moduleId}' not found. Available modules: ${available || '(none)'}`);
  }

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxSymbols = options.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const maxFlows = options.maxFlows ?? DEFAULT_MAX_FLOWS;
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES;
  const moduleFileSet = new Set(module.files);
  const moduleSymbolSet = new Set(module.symbols);
  const moduleFileIds = new Set(module.files.map((filePath) => `file:${filePath}`));

  const files = index.files
    .filter((file) => moduleFileSet.has(file.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const symbols = index.symbols
    .filter((symbol) => moduleSymbolSet.has(symbol.id))
    .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine);
  const entryPoints = index.entryPoints
    .filter((entry) => entry.moduleId === module.id || moduleFileSet.has(entry.filePath))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  const executionFlows = index.executionFlows
    .filter((flow) => flow.moduleIds.includes(module.id))
    .sort((left, right) => left.name.localeCompare(right.name));
  const edges = index.edges
    .filter((edge) => (
      moduleSymbolSet.has(edge.source)
      || moduleSymbolSet.has(edge.target)
      || moduleFileIds.has(edge.source)
      || moduleFileIds.has(edge.target)
    ))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.source.localeCompare(right.source));

  return {
    indexPath,
    indexGenerated,
    generatedAt: index.generatedAt,
    module,
    totals: {
      files: files.length,
      symbols: symbols.length,
      entryPoints: entryPoints.length,
      executionFlows: executionFlows.length,
      edges: edges.length,
    },
    truncated: {
      files: files.length > maxFiles,
      symbols: symbols.length > maxSymbols,
      executionFlows: executionFlows.length > maxFlows,
      edges: edges.length > maxEdges,
    },
    files: files.slice(0, maxFiles).map((file) => ({
      id: file.id,
      path: file.path,
      language: file.language,
      hash: file.hash,
      lineCount: file.lineCount,
      terms: file.terms,
    })),
    symbols: symbols.slice(0, maxSymbols).map((symbol) => ({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      filePath: symbol.filePath,
      language: symbol.language,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      signature: symbol.signature,
      terms: symbol.terms,
    })),
    entryPoints,
    executionFlows: executionFlows.slice(0, maxFlows),
    edges: edges.slice(0, maxEdges),
  };
}
