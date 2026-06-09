import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import fg from 'fast-glob';
import {
  INFRA_CODE_INDEX_VERSION,
  type CodeEdge,
  type CodeEntryPoint,
  type CodeEntryPointKind,
  type CodeExecutionFlow,
  type CodeExecutionFlowStep,
  type CodeFile,
  type CodeGraphConfidence,
  type CodeLanguage,
  type CodeModule,
  type CodeSymbol,
  type CodeSymbolKind,
  type InfraCodeIndex,
} from './types.js';
import { termsFromPath, termsFromSymbol, uniqueTerms } from './text.js';
import { extractWithTreeSitter, loadTreeSitterGrammarsForFiles } from './tree-sitter.js';

export const INFRA_CODE_DIR = path.join('infraspec', '.code-graph');
export const INFRA_CODE_INDEX_FILE = 'index.json';

const MAX_FILE_SIZE_BYTES = 750 * 1024;
const MAX_CALL_EDGES = 8000;

const SOURCE_PATTERNS = [
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java}',
];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/coverage/**',
  '**/src/test/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.codegraph/**',
  '**/infraspec/**',
  '**/.cline/**',
  '**/.claude/**',
  '**/.cursor/**',
  '**/.roo/**',
];

const CONTROL_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'sizeof',
  'new', 'super', 'await', 'yield', 'function',
]);

const GENERIC_SOURCE_ROOTS = new Set([
  'src', 'source', 'lib', 'app', 'main', 'java', 'kotlin', 'typescript', 'javascript',
  'python', 'test', 'tests', '__tests__',
]);

const TECHNICAL_SUFFIXES = new Set([
  'controller', 'controllers', 'business', 'biz', 'service', 'services',
  'dao', 'mapper', 'mappers', 'repository', 'repositories', 'repo', 'repos',
  'entity', 'entities', 'model', 'models', 'domain', 'dto', 'vo', 'bo', 'po',
  'do', 'request', 'response', 'form', 'param', 'handler', 'handlers', 'route',
  'routes', 'router', 'api', 'client', 'clients', 'adapter', 'adapters',
  'component', 'components', 'page', 'pages', 'job', 'jobs', 'task', 'tasks',
  'consumer', 'consumers', 'listener', 'listeners', 'config', 'configuration',
  'manager', 'processor', 'command', 'commands',
]);

const JAVA_PACKAGE_ROOTS = new Set([
  'com', 'org', 'net', 'io', 'cn', 'edu', 'gov', 'mil', 'java', 'javax',
]);

const ENTRY_NAME_HINTS = new Set([
  'main', 'run', 'execute', 'exec', 'start', 'handle', 'handler', 'process',
  'register', 'route', 'bootstrap',
]);

const ENTRY_PATH_HINTS: Array<[CodeEntryPointKind, RegExp, number, string]> = [
  ['cli', /(^|\/)(commands?|cli)(\/|$)/u, 32, 'path suggests CLI command entry'],
  ['controller', /(^|\/)controllers?(\/|$)/u, 30, 'path suggests controller entry'],
  ['route', /(^|\/)(routes?|router)(\/|$)/u, 28, 'path suggests route entry'],
  ['api', /(^|\/)api(\/|$)/u, 24, 'path suggests API entry'],
  ['job', /(^|\/)(jobs?|tasks?|consumers?|listeners?)(\/|$)/u, 24, 'path suggests background entry'],
  ['component', /(^|\/)(pages?|components?)(\/|$)/u, 18, 'path suggests UI entry'],
  ['handler', /(^|\/)handlers?(\/|$)/u, 24, 'path suggests handler entry'],
];

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function fileId(filePath: string): string {
  return `file:${filePath}`;
}

function symbolId(filePath: string, name: string, startLine: number): string {
  return `symbol:${filePath}:${startLine}:${name}`;
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function slugify(value: string): string {
  const slug = splitNameTokens(value).join('-');
  return slug || 'unknown';
}

function toTitleCase(value: string): string {
  return splitNameTokens(value)
    .map((token) => token.length <= 3 ? token.toUpperCase() : `${token[0]?.toUpperCase() ?? ''}${token.slice(1)}`)
    .join(' ') || value;
}

function singularize(value: string): string {
  if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith('s') && value.length > 3) return value.slice(0, -1);
  return value;
}

function normalizeLayerToken(value: string): string {
  return singularize(slugify(value).replace(/-/g, ''));
}

function isTechnicalLayer(value: string): boolean {
  const normalized = normalizeLayerToken(value);
  return TECHNICAL_SUFFIXES.has(value.toLowerCase()) || TECHNICAL_SUFFIXES.has(normalized);
}

function splitNameTokens(value: string): string[] {
  const normalized = value
    .replace(/\.[^.]+$/u, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_./\\:-]+/g, ' ');

  return normalized
    .split(/[^A-Za-z0-9]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function stripTechnicalSuffix(tokens: string[], leafDir?: string): { tokens: string[]; layer?: string } {
  if (tokens.length <= 1) return { tokens };

  const last = tokens[tokens.length - 1] ?? '';
  const normalizedLast = normalizeLayerToken(last);
  const normalizedLeaf = leafDir ? normalizeLayerToken(leafDir) : '';

  if (normalizedLeaf && normalizedLast === normalizedLeaf) {
    return {
      tokens: tokens.slice(0, -1),
      layer: leafDir,
    };
  }

  if (TECHNICAL_SUFFIXES.has(last) || TECHNICAL_SUFFIXES.has(normalizedLast)) {
    return {
      tokens: tokens.slice(0, -1),
      layer: last,
    };
  }

  return { tokens };
}

function javaPackagePartsFromPath(filePath: string): string[] | undefined {
  if (path.extname(filePath).toLowerCase() !== '.java') return undefined;

  const directory = path.posix.dirname(filePath);
  const parts = directory.split('/').filter(Boolean);
  const srcIndex = parts.findIndex((part) => part === 'src');
  if (srcIndex < 0) return undefined;

  const afterSrc = parts.slice(srcIndex + 1);
  if (afterSrc[0] === 'main' && afterSrc[1] === 'java') {
    return afterSrc.slice(2);
  }

  if (afterSrc[0] === 'java') {
    return afterSrc.slice(1);
  }

  return undefined;
}

function stripJavaPackageNamespace(parts: string[]): string[] {
  if (parts.length === 0 || !JAVA_PACKAGE_ROOTS.has(parts[0]?.toLowerCase() ?? '')) {
    return parts;
  }

  if (parts.length <= 2) {
    return [];
  }

  // Java package roots are organization namespace, not business modules.
  return parts.slice(2);
}

function compactJavaPathRoot(filePath: string): string | undefined {
  const packageParts = javaPackagePartsFromPath(filePath);
  if (!packageParts) return undefined;

  const basename = path.posix.basename(filePath, path.posix.extname(filePath));
  if (packageParts.length === 0) {
    return `src/${basename}`;
  }

  const layerIndex = packageParts.findIndex((part) => isTechnicalLayer(part));
  if (layerIndex > 0) {
    return `src/${packageParts[layerIndex - 1]}`;
  }

  const businessParts = stripJavaPackageNamespace(packageParts);
  const businessRoot = businessParts.length > 0
    ? businessParts[businessParts.length - 1]
    : basename;

  return `src/${businessRoot}`;
}

function compactPathRoot(filePath: string): string {
  const javaRoot = compactJavaPathRoot(filePath);
  if (javaRoot) return javaRoot;

  const directory = path.posix.dirname(filePath);
  if (directory === '.') return path.posix.basename(filePath, path.posix.extname(filePath));

  const parts = directory.split('/').filter(Boolean);
  const srcIndex = parts.findIndex((part) => part === 'src');
  if (srcIndex >= 0) {
    const afterSrc = parts.slice(srcIndex + 1);
    if (afterSrc[0] === 'main') {
      const afterMain = afterSrc.slice(1).filter((part) => !['java', 'kotlin', 'resources'].includes(part));
      return ['src', ...afterMain.slice(0, 2)].join('/');
    }
    if (afterSrc[0] === 'core' && afterSrc[1]) {
      return ['src', 'core', afterSrc[1]].join('/');
    }
    if (afterSrc[0]) {
      return ['src', afterSrc[0]].join('/');
    }
  }

  return parts.slice(0, Math.min(2, parts.length)).join('/') || directory;
}

function moduleIdFromPath(filePath: string): string {
  const root = compactPathRoot(filePath);
  if (GENERIC_SOURCE_ROOTS.has(root)) {
    return slugify(path.posix.basename(filePath, path.posix.extname(filePath)));
  }
  return slugify(root.replace(/^src\//u, ''));
}

function moduleStemFromFile(file: CodeFile, symbols: CodeSymbol[]): { id: string; layer?: string; source: 'name' | 'directory' } {
  const leafDir = path.posix.basename(path.posix.dirname(file.path));
  const preferredSymbol = symbols.find((symbol) => ['class', 'component', 'function', 'interface'].includes(symbol.kind));
  const candidates = [
    preferredSymbol?.name,
    path.posix.basename(file.path, path.posix.extname(file.path)),
    ...symbols.slice(0, 2).map((symbol) => symbol.name),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const tokens = splitNameTokens(candidate);
    const stripped = stripTechnicalSuffix(tokens, leafDir);
    if (stripped.tokens.length > 0 && stripped.tokens.length < tokens.length) {
      return {
        id: stripped.tokens.join('-'),
        layer: stripped.layer ?? leafDir,
        source: 'name',
      };
    }

    if (tokens.length > 0 && isTechnicalLayer(leafDir) && !isTechnicalLayer(tokens[tokens.length - 1] ?? '')) {
      return {
        id: tokens.join('-'),
        layer: leafDir,
        source: 'name',
      };
    }
  }

  return {
    id: moduleIdFromPath(file.path),
    source: 'directory',
  };
}

function detectLanguage(filePath: string): CodeLanguage {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.java':
      return 'java';
    default:
      return 'unknown';
  }
}

function extractImports(content: string, language: CodeLanguage): string[] {
  const imports = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  if (language === 'python') {
    patterns.push(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm);
    patterns.push(/^\s*import\s+([A-Za-z0-9_.]+)/gm);
  }

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) imports.add(value);
    }
  }

  return [...imports].sort();
}

function findEndLine(lines: string[], startIndex: number): number {
  let depth = 0;
  let sawBrace = false;
  const maxIndex = Math.min(lines.length - 1, startIndex + 300);

  for (let i = startIndex; i <= maxIndex; i++) {
    for (const char of lines[i] ?? '') {
      if (char === '{') {
        depth++;
        sawBrace = true;
      } else if (char === '}') {
        depth--;
      }
    }

    if (sawBrace && depth <= 0) {
      return i + 1;
    }
  }

  if (!sawBrace) return startIndex + 1;
  return Math.min(lines.length, startIndex + 80);
}

function makeSymbol(
  filePath: string,
  language: CodeLanguage,
  lines: string[],
  lineIndex: number,
  kind: CodeSymbolKind,
  name: string,
  exported: boolean,
  signature: string
): CodeSymbol {
  const startLine = lineIndex + 1;
  const endLine = findEndLine(lines, lineIndex);
  return {
    id: symbolId(filePath, name, startLine),
    name,
    kind,
    filePath,
    language,
    startLine,
    endLine,
    signature: signature.trim().slice(0, 240),
    exported,
    terms: termsFromSymbol(name, signature),
  };
}

function isInsideRange(lineNumber: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => lineNumber > range.start && lineNumber <= range.end);
}

function extractTypeScriptSymbols(filePath: string, language: CodeLanguage, lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const classRanges: Array<{ start: number; end: number }> = [];

  lines.forEach((line, index) => {
    const classMatch = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch?.[1]) {
      const symbol = makeSymbol(filePath, language, lines, index, 'class', classMatch[1], line.includes('export'), line);
      symbols.push(symbol);
      classRanges.push({ start: symbol.startLine, end: symbol.endLine });
      return;
    }

    const interfaceMatch = line.match(/^\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/);
    if (interfaceMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'interface', interfaceMatch[1], line.includes('export'), line));
      return;
    }

    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/);
    if (typeMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'type', typeMatch[1], line.includes('export'), line));
      return;
    }

    const enumMatch = line.match(/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/);
    if (enumMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'enum', enumMatch[1], line.includes('export'), line));
      return;
    }

    const functionMatch = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (functionMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'function', functionMatch[1], line.includes('export'), line));
      return;
    }

    const arrowMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (arrowMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'function', arrowMatch[1], line.includes('export'), line));
      return;
    }

    const variableMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (variableMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'variable', variableMatch[1], line.includes('export'), line));
    }
  });

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!isInsideRange(lineNumber, classRanges)) return;

    const methodMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:A-Za-z0-9_<>,[\]\s|.?]*\{/);
    const name = methodMatch?.[1];
    if (!name || CONTROL_CALLS.has(name)) return;
    symbols.push(makeSymbol(filePath, language, lines, index, 'method', name, line.includes('public'), line));
  });

  return symbols;
}

function extractSimpleSymbols(filePath: string, language: CodeLanguage, lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const patternsByLanguage: Record<CodeLanguage, Array<[CodeSymbolKind, RegExp]>> = {
    python: [
      ['class', /^\s*class\s+([A-Za-z_][\w]*)/],
      ['function', /^\s*def\s+([A-Za-z_][\w]*)\s*\(/],
    ],
    java: [
      ['class', /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/],
      ['interface', /^\s*(?:public\s+)?interface\s+([A-Za-z_][\w]*)/],
      ['method', /^\s*(?:public|private|protected)\s+(?:static\s+)?[A-Za-z_<>\[\], ?]+\s+([A-Za-z_][\w]*)\s*\(/],
    ],
    unknown: [],
    typescript: [],
    javascript: [],
  };
  const patterns = patternsByLanguage[language];

  lines.forEach((line, index) => {
    for (const [kind, pattern] of patterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        symbols.push(makeSymbol(filePath, language, lines, index, kind, match[1], line.includes('export') || line.includes('pub '), line));
        break;
      }
    }
  });

  return symbols;
}

function extractSymbols(filePath: string, language: CodeLanguage, content: string): CodeSymbol[] {
  const lines = content.split('\n');
  if (language === 'typescript' || language === 'javascript') {
    return extractTypeScriptSymbols(filePath, language, lines);
  }
  return extractSimpleSymbols(filePath, language, lines);
}

function resolveRelativeImport(sourceFilePath: string, importPath: string, filesByPath: Map<string, CodeFile>): string | undefined {
  if (!importPath.startsWith('.')) return undefined;

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFilePath), importPath));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.py`,
    path.posix.join(base, 'index.ts'),
    path.posix.join(base, 'index.tsx'),
    path.posix.join(base, 'index.js'),
    path.posix.join(base, 'index.jsx'),
  ];

  return candidates.find((candidate) => filesByPath.has(candidate));
}

function extractCallNames(content: string): Set<string> {
  const names = new Set<string>();
  const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(content)) !== null) {
    const name = match[1];
    if (name && !CONTROL_CALLS.has(name)) {
      names.add(name);
    }
  }
  return names;
}

function buildEdges(files: CodeFile[], symbols: CodeSymbol[], contentsByPath: Map<string, string>): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const edgeKeys = new Set<string>();
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const symbolsByName = new Map<string, CodeSymbol[]>();

  for (const symbol of symbols) {
    const list = symbolsByName.get(symbol.name) ?? [];
    list.push(symbol);
    symbolsByName.set(symbol.name, list);
  }

  const addEdge = (edge: CodeEdge) => {
    const key = `${edge.source}:${edge.target}:${edge.kind}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push(edge);
    }
  };

  const importedFilesBySource = new Map<string, Set<string>>();
  for (const file of files) {
    const importedFiles = new Set<string>();
    for (const importPath of file.imports) {
      const targetPath = resolveRelativeImport(file.path, importPath, filesByPath);
      if (!targetPath) continue;
      importedFiles.add(targetPath);
      addEdge({
        source: file.id,
        target: fileId(targetPath),
        kind: 'imports',
        confidence: 'high',
      });
    }
    importedFilesBySource.set(file.path, importedFiles);
  }

  for (const source of symbols) {
    if (edges.length >= MAX_CALL_EDGES) break;
    const content = contentsByPath.get(source.filePath);
    if (!content) continue;
    const lines = content.split('\n');
    const symbolContent = lines.slice(source.startLine - 1, source.endLine).join('\n');
    const callNames = extractCallNames(symbolContent);
    const importedFiles = importedFilesBySource.get(source.filePath) ?? new Set<string>();

    for (const callName of callNames) {
      if (edges.length >= MAX_CALL_EDGES) break;
      const targets = symbolsByName.get(callName);
      if (!targets) continue;

      const rankedTargets = [...targets].sort((left, right) => {
        const leftScore = left.filePath === source.filePath ? 2 : importedFiles.has(left.filePath) ? 1 : 0;
        const rightScore = right.filePath === source.filePath ? 2 : importedFiles.has(right.filePath) ? 1 : 0;
        return rightScore - leftScore;
      });

      for (const target of rankedTargets.slice(0, 3)) {
        if (target.id === source.id) continue;
        addEdge({
          source: source.id,
          target: target.id,
          kind: 'calls',
          confidence: target.filePath === source.filePath ? 'high' : importedFiles.has(target.filePath) ? 'medium' : 'low',
        });
      }
    }
  }

  return edges;
}

function buildModules(files: CodeFile[], symbols: CodeSymbol[], edges: CodeEdge[]): CodeModule[] {
  const symbolsByFile = new Map<string, CodeSymbol[]>();
  for (const symbol of symbols) {
    const list = symbolsByFile.get(symbol.filePath) ?? [];
    list.push(symbol);
    symbolsByFile.set(symbol.filePath, list);
  }

  const fileInfos = files.map((file) => {
    const fileSymbols = symbolsByFile.get(file.path) ?? [];
    const stem = moduleStemFromFile(file, fileSymbols);
    const leafDir = path.posix.basename(path.posix.dirname(file.path));
    return {
      file,
      symbols: fileSymbols,
      stem,
      leafDir,
    };
  });

  const stemDirs = new Map<string, Set<string>>();
  for (const info of fileInfos) {
    const dirs = stemDirs.get(info.stem.id) ?? new Set<string>();
    dirs.add(info.leafDir);
    stemDirs.set(info.stem.id, dirs);
  }

  const layerDirs = new Set<string>();
  for (const info of fileInfos) {
    const normalizedLeaf = normalizeLayerToken(info.leafDir);
    if (info.stem.layer || TECHNICAL_SUFFIXES.has(normalizedLeaf)) {
      layerDirs.add(info.leafDir);
    }
    const dirs = stemDirs.get(info.stem.id);
    if (dirs && dirs.size >= 2 && info.stem.source === 'name') {
      for (const dir of dirs) layerDirs.add(dir);
    }
  }

  const edgeWeightsByFile = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== 'calls' && edge.kind !== 'imports') continue;
    const sourcePath = edge.source.startsWith('file:')
      ? edge.source.slice('file:'.length)
      : symbols.find((symbol) => symbol.id === edge.source)?.filePath;
    const targetPath = edge.target.startsWith('file:')
      ? edge.target.slice('file:'.length)
      : symbols.find((symbol) => symbol.id === edge.target)?.filePath;
    if (sourcePath) edgeWeightsByFile.set(sourcePath, (edgeWeightsByFile.get(sourcePath) ?? 0) + 1);
    if (targetPath) edgeWeightsByFile.set(targetPath, (edgeWeightsByFile.get(targetPath) ?? 0) + 1);
  }

  interface ModuleDraft {
    id: string;
    strategy: CodeModule['strategy'];
    files: Set<string>;
    symbols: Set<string>;
    rootPaths: Set<string>;
    layers: Set<string>;
    terms: Set<string>;
    languages: Set<CodeLanguage>;
    edgeWeight: number;
  }

  const drafts = new Map<string, ModuleDraft>();
  const getDraft = (id: string, strategy: CodeModule['strategy']): ModuleDraft => {
    const existing = drafts.get(id);
    if (existing) {
      if (existing.strategy === 'directory' && strategy === 'hybrid-lightweight') {
        existing.strategy = strategy;
      }
      return existing;
    }

    const draft: ModuleDraft = {
      id,
      strategy,
      files: new Set<string>(),
      symbols: new Set<string>(),
      rootPaths: new Set<string>(),
      layers: new Set<string>(),
      terms: new Set<string>(),
      languages: new Set<CodeLanguage>(),
      edgeWeight: 0,
    };
    drafts.set(id, draft);
    return draft;
  };

  for (const info of fileInfos) {
    const isLayered = layerDirs.has(info.leafDir) && info.stem.source === 'name';
    const moduleId = isLayered ? info.stem.id : moduleIdFromPath(info.file.path);
    const strategy: CodeModule['strategy'] = isLayered ? 'hybrid-lightweight' : 'directory';
    const draft = getDraft(moduleId, strategy);
    draft.files.add(info.file.path);
    draft.rootPaths.add(isLayered ? path.posix.dirname(info.file.path) : compactPathRoot(info.file.path));
    draft.languages.add(info.file.language);
    draft.edgeWeight += edgeWeightsByFile.get(info.file.path) ?? 0;
    for (const term of [...info.file.terms, ...splitNameTokens(moduleId)]) draft.terms.add(term);
    if (isLayered) draft.layers.add(info.leafDir);
    for (const symbol of info.symbols) {
      draft.symbols.add(symbol.id);
      for (const term of symbol.terms) draft.terms.add(term);
    }
  }

  return [...drafts.values()]
    .map((draft): CodeModule => {
      const fileCount = draft.files.size;
      const symbolCount = draft.symbols.size;
      const confidence: CodeGraphConfidence = draft.strategy === 'hybrid-lightweight' && draft.layers.size >= 2
        ? 'high'
        : fileCount >= 2 || draft.edgeWeight > 0
          ? 'medium'
          : 'low';

      return {
        id: draft.id,
        name: toTitleCase(draft.id),
        strategy: draft.strategy,
        confidence,
        rootPaths: [...draft.rootPaths].sort(),
        layers: [...draft.layers].sort(),
        files: [...draft.files].sort(),
        symbols: [...draft.symbols].sort(),
        terms: uniqueTerms(draft.terms),
        languages: [...draft.languages].sort(),
        fileCount,
        symbolCount,
      };
    })
    .sort((left, right) => right.fileCount - left.fileCount || left.id.localeCompare(right.id));
}

function confidenceFromScore(score: number): CodeGraphConfidence {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function classifyEntryPoint(symbol: CodeSymbol, file: CodeFile, outgoingCount: number, incomingCount: number): Omit<CodeEntryPoint, 'id' | 'symbolId' | 'moduleId'> | null {
  let score = 0;
  let kind: CodeEntryPointKind = 'unknown';
  const reasons = new Set<string>();
  const pathLower = file.path.toLowerCase();
  const nameTokens = splitNameTokens(symbol.name);
  const signatureLower = symbol.signature?.toLowerCase() ?? '';

  for (const [candidateKind, pattern, boost, reason] of ENTRY_PATH_HINTS) {
    if (pattern.test(pathLower)) {
      score += boost;
      if (kind === 'unknown') kind = candidateKind;
      reasons.add(reason);
    }
  }

  if (symbol.kind === 'component') {
    score += 35;
    kind = 'component';
    reasons.add('symbol is a React component');
  }

  if (symbol.name === 'main' || nameTokens.includes('main')) {
    score += 32;
    kind = 'main';
    reasons.add('symbol name suggests main entry');
  }

  if (nameTokens.some((token) => ENTRY_NAME_HINTS.has(token))) {
    score += 18;
    if (kind === 'unknown') kind = 'handler';
    reasons.add('symbol name suggests entry behavior');
  }

  if (symbol.exported) {
    score += 14;
    reasons.add('symbol is exported or public');
  }

  if (signatureLower.includes('@controller') || signatureLower.includes('@restcontroller')) {
    score += 34;
    kind = 'controller';
    reasons.add('signature suggests controller annotation');
  }

  if (signatureLower.includes('@get') || signatureLower.includes('@post') || signatureLower.includes('@requestmapping')) {
    score += 28;
    kind = 'route';
    reasons.add('signature suggests route annotation');
  }

  if (outgoingCount > 0) {
    score += Math.min(18, outgoingCount * 4);
    reasons.add('entry symbol calls other symbols');
  }

  if (incomingCount === 0 && outgoingCount > 0) {
    score += 10;
    reasons.add('entry symbol has no indexed callers');
  }

  if (!['function', 'method', 'class', 'component'].includes(symbol.kind)) return null;
  if (score < 35) return null;

  return {
    name: symbol.name,
    kind,
    filePath: symbol.filePath,
    score,
    confidence: confidenceFromScore(score),
    reasons: [...reasons],
  };
}

function buildEntryPoints(files: CodeFile[], symbols: CodeSymbol[], edges: CodeEdge[], modules: CodeModule[]): CodeEntryPoint[] {
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const moduleByFile = new Map<string, string>();
  for (const module of modules) {
    for (const filePath of module.files) {
      moduleByFile.set(filePath, module.id);
    }
  }

  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== 'calls') continue;
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }

  return symbols
    .map((symbol): CodeEntryPoint | null => {
      const file = fileByPath.get(symbol.filePath);
      if (!file) return null;
      const entry = classifyEntryPoint(symbol, file, outgoing.get(symbol.id) ?? 0, incoming.get(symbol.id) ?? 0);
      if (!entry) return null;
      return {
        id: `entry:${symbol.id}`,
        symbolId: symbol.id,
        moduleId: moduleByFile.get(symbol.filePath),
        ...entry,
      };
    })
    .filter((entry): entry is CodeEntryPoint => entry !== null)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, 80);
}

function buildExecutionFlows(symbols: CodeSymbol[], edges: CodeEdge[], entryPoints: CodeEntryPoint[], modules: CodeModule[]): CodeExecutionFlow[] {
  const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const moduleByFile = new Map<string, string>();
  for (const module of modules) {
    for (const filePath of module.files) {
      moduleByFile.set(filePath, module.id);
    }
  }

  const callsBySource = new Map<string, CodeEdge[]>();
  for (const edge of edges) {
    if (edge.kind !== 'calls') continue;
    const list = callsBySource.get(edge.source) ?? [];
    list.push(edge);
    callsBySource.set(edge.source, list);
  }

  const flows: CodeExecutionFlow[] = [];
  const maxFlows = 40;
  const maxDepth = 5;

  for (const entryPoint of entryPoints) {
    if (flows.length >= maxFlows) break;
    const steps: CodeExecutionFlowStep[] = [];
    const flowEdges: string[] = [];
    const warnings: string[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = entryPoint.symbolId;
    let sawMediumConfidence = false;

    for (let depth = 0; depth < maxDepth && currentId; depth++) {
      const symbol = symbolById.get(currentId);
      if (!symbol || visited.has(currentId)) break;
      visited.add(currentId);
      steps.push({
        symbolId: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        filePath: symbol.filePath,
        startLine: symbol.startLine,
      });

      const currentModuleId = moduleByFile.get(symbol.filePath);
      const candidates: CodeEdge[] = (callsBySource.get(currentId) ?? [])
        .filter((edge) => {
          if (visited.has(edge.target)) return false;
          const targetSymbol = symbolById.get(edge.target);
          if (!targetSymbol) return false;
          if (edge.confidence !== 'low') return true;
          return currentModuleId !== undefined && moduleByFile.get(targetSymbol.filePath) === currentModuleId;
        })
        .sort((left, right) => {
          const confidenceScore = (edge: CodeEdge) => edge.confidence === 'high' ? 3 : edge.confidence === 'medium' ? 2 : 1;
          return confidenceScore(right) - confidenceScore(left);
        });

      if (candidates.length === 0) break;
      if (candidates.length > 2) {
        warnings.push(`Multiple call targets from ${symbol.name}; kept the highest-confidence path.`);
      }

      const next = candidates[0];
      if (!next) break;
      if (next.confidence !== 'high') sawMediumConfidence = true;
      flowEdges.push(`${next.source}->${next.target}`);
      currentId = next.target;
    }

    if (steps.length < 2) continue;
    const moduleIds = uniqueTerms(steps.map((step) => moduleByFile.get(step.filePath) ?? '').filter(Boolean));
    const confidence: CodeGraphConfidence = warnings.length === 0 && !sawMediumConfidence ? 'high' : 'medium';
    const entryName = entryPoint.name;
    flows.push({
      id: `execution-flow:${slugify(`${entryName}-${entryPoint.filePath}`)}`,
      name: `${entryName} Execution Flow`,
      entryPointId: entryPoint.id,
      moduleIds,
      confidence,
      steps,
      edges: flowEdges,
      warnings,
    });
  }

  return flows;
}

export function getInfraCodeIndexDir(projectRoot: string): string {
  return path.join(projectRoot, INFRA_CODE_DIR);
}

export function getInfraCodeIndexPath(projectRoot: string): string {
  return path.join(getInfraCodeIndexDir(projectRoot), INFRA_CODE_INDEX_FILE);
}

export async function buildInfraCodeIndex(projectRoot: string): Promise<InfraCodeIndex> {
  const entries = await fg(SOURCE_PATTERNS, {
    cwd: projectRoot,
    onlyFiles: true,
    dot: false,
    unique: true,
    ignore: IGNORE_PATTERNS,
  });
  const sortedEntries = entries.map(toPosix).sort();
  const detectedFiles = sortedEntries.map((entry) => ({
    path: entry,
    language: detectLanguage(entry),
  }));
  const parseErrors = await loadTreeSitterGrammarsForFiles(detectedFiles);

  const files: CodeFile[] = [];
  const symbols: CodeSymbol[] = [];
  const contentsByPath = new Map<string, string>();
  let skippedLargeFiles = 0;
  let treeSitterFiles = 0;
  let regexFallbackFiles = 0;

  for (const relativePath of sortedEntries) {
    const absolutePath = path.join(projectRoot, relativePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      skippedLargeFiles++;
      continue;
    }

    const content = await fs.readFile(absolutePath, 'utf-8');
    const language = detectLanguage(relativePath);
    const treeSitterExtraction = extractWithTreeSitter(relativePath, language, content);
    if (treeSitterExtraction?.errors.length) {
      parseErrors.push(...treeSitterExtraction.errors);
    }

    const useTreeSitter = treeSitterExtraction
      && (treeSitterExtraction.symbols.length > 0 || treeSitterExtraction.imports.length > 0);
    const fileSymbols = useTreeSitter
      ? treeSitterExtraction.symbols
      : extractSymbols(relativePath, language, content);
    if (useTreeSitter) {
      treeSitterFiles++;
    } else {
      regexFallbackFiles++;
    }

    const imports = [...new Set([
      ...extractImports(content, language),
      ...(treeSitterExtraction?.imports ?? []),
    ])].sort();
    const lineCount = content.split('\n').length;
    const fileTerms = uniqueTerms([
      ...termsFromPath(relativePath),
      ...imports.flatMap((item) => termsFromPath(item)),
      ...fileSymbols.flatMap((symbol) => symbol.terms),
    ]);

    files.push({
      id: fileId(relativePath),
      path: relativePath,
      language,
      hash: hashContent(content),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      lineCount,
      terms: fileTerms,
      imports,
    });
    symbols.push(...fileSymbols);
    contentsByPath.set(relativePath, content);
  }

  const edges = buildEdges(files, symbols, contentsByPath);
  const modules = buildModules(files, symbols, edges);
  const entryPoints = buildEntryPoints(files, symbols, edges, modules);
  const executionFlows = buildExecutionFlows(symbols, edges, entryPoints, modules);
  const parserBackend = treeSitterFiles > 0 && regexFallbackFiles > 0
    ? 'mixed'
    : treeSitterFiles > 0
      ? 'tree-sitter-wasm'
      : 'regex';

  return {
    version: INFRA_CODE_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    projectRoot,
    files,
    symbols,
    edges,
    modules,
    entryPoints,
    executionFlows,
    stats: {
      fileCount: files.length,
      symbolCount: symbols.length,
      edgeCount: edges.length,
      moduleCount: modules.length,
      entryPointCount: entryPoints.length,
      executionFlowCount: executionFlows.length,
      skippedLargeFiles,
      parserBackend,
      treeSitterFiles,
      regexFallbackFiles,
      parseErrors: parseErrors.slice(0, 20),
    },
  };
}

export async function writeInfraCodeIndex(projectRoot: string, index: InfraCodeIndex): Promise<string> {
  const indexDir = getInfraCodeIndexDir(projectRoot);
  const indexPath = getInfraCodeIndexPath(projectRoot);
  await fs.mkdir(indexDir, { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  return indexPath;
}

export async function readInfraCodeIndex(projectRoot: string): Promise<InfraCodeIndex> {
  const indexPath = getInfraCodeIndexPath(projectRoot);
  const content = await fs.readFile(indexPath, 'utf-8');
  return JSON.parse(content) as InfraCodeIndex;
}
