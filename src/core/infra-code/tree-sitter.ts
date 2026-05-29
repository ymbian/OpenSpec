import { createRequire } from 'node:module';
import path from 'node:path';
import type { Language as WasmLanguage, Node as SyntaxNode, Parser } from 'web-tree-sitter';
import {
  type CodeLanguage,
  type CodeSymbol,
  type CodeSymbolKind,
} from './types.js';
import { termsFromSymbol } from './text.js';

type GrammarLanguage = 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'python' | 'java';

interface TreeSitterRuntime {
  Parser: {
    init(): Promise<void>;
    new(): Parser;
  };
  Language: {
    load(wasmPath: string): Promise<WasmLanguage>;
  };
}

export interface TreeSitterExtraction {
  symbols: CodeSymbol[];
  imports: string[];
  errors: string[];
}

const require = createRequire(import.meta.url);

const GRAMMAR_WASM_FILES: Record<GrammarLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
};

const languageCache = new Map<GrammarLanguage, WasmLanguage>();
const parserCache = new Map<GrammarLanguage, Parser>();
const unavailableGrammarErrors = new Map<GrammarLanguage, string>();

let runtime: TreeSitterRuntime | null = null;
let initialized = false;

function getRuntime(): TreeSitterRuntime {
  if (!runtime) {
    runtime = require('web-tree-sitter') as TreeSitterRuntime;
  }
  return runtime;
}

async function initTreeSitter(): Promise<void> {
  if (initialized) return;
  const { Parser: ParserRuntime } = getRuntime();
  await ParserRuntime.init();
  initialized = true;
}

function grammarForFile(filePath: string, language: CodeLanguage): GrammarLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx') return 'jsx';
  if (language === 'typescript') return 'typescript';
  if (language === 'javascript') return 'javascript';
  if (language === 'python') return 'python';
  if (language === 'java') return 'java';
  return null;
}

async function loadGrammar(grammar: GrammarLanguage): Promise<void> {
  if (languageCache.has(grammar) || unavailableGrammarErrors.has(grammar)) return;
  await initTreeSitter();

  try {
    const { Language } = getRuntime();
    const wasmPath = require.resolve(`tree-sitter-wasms/out/${GRAMMAR_WASM_FILES[grammar]}`);
    const language = await Language.load(wasmPath);
    languageCache.set(grammar, language);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    unavailableGrammarErrors.set(grammar, message);
  }
}

export async function loadTreeSitterGrammarsForFiles(
  files: Array<{ path: string; language: CodeLanguage }>
): Promise<string[]> {
  const grammars = [...new Set(files.map((file) => grammarForFile(file.path, file.language)).filter(Boolean))] as GrammarLanguage[];
  for (const grammar of grammars) {
    await loadGrammar(grammar);
  }

  return [...unavailableGrammarErrors.entries()].map(([grammar, error]) => `${grammar}: ${error}`);
}

function getParser(grammar: GrammarLanguage): Parser | null {
  const cached = parserCache.get(grammar);
  if (cached) return cached;

  const language = languageCache.get(grammar);
  if (!language) return null;

  const { Parser: ParserRuntime } = getRuntime();
  const parser = new ParserRuntime();
  parser.setLanguage(language);
  parserCache.set(grammar, parser);
  return parser;
}

function symbolId(filePath: string, name: string, startLine: number): string {
  return `symbol:${filePath}:${startLine}:${name}`;
}

function getNodeText(source: string, node: SyntaxNode): string {
  return source.slice(node.startIndex, node.endIndex);
}

function getChildByTypes(node: SyntaxNode, types: string[]): SyntaxNode | null {
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index);
    if (child && types.includes(child.type)) return child;
  }
  return null;
}

function getNameNode(node: SyntaxNode): SyntaxNode | null {
  return node.childForFieldName('name')
    ?? getChildByTypes(node, ['identifier', 'type_identifier', 'property_identifier']);
}

function getName(node: SyntaxNode, source: string): string | null {
  const nameNode = getNameNode(node);
  if (!nameNode) return null;
  const name = getNodeText(source, nameNode).trim();
  return name || null;
}

function isExported(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.type === 'export_statement') return true;
    current = current.parent;
  }
  return false;
}

function isPublicJava(node: SyntaxNode): boolean {
  return /^public\b/.test(node.text.trim()) || /\bpublic\s+/.test(node.text.slice(0, 80));
}

function isInsideClass(node: SyntaxNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'class_definition') return true;
    current = current.parent;
  }
  return false;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function containsJsx(node: SyntaxNode): boolean {
  return node.descendantsOfType([
    'jsx_element',
    'jsx_self_closing_element',
    'jsx_fragment',
  ]).length > 0;
}

function findFunctionInitializer(node: SyntaxNode): SyntaxNode | null {
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index);
    if (!child) continue;
    if (child.type === 'arrow_function' || child.type === 'function_expression') return child;
    if (child.type === 'call_expression') {
      const nested = child.descendantsOfType(['arrow_function', 'function_expression'])[0];
      if (nested) return nested;
    }
  }
  return null;
}

function buildSignature(source: string, node: SyntaxNode): string {
  const body = node.childForFieldName('body');
  const endIndex = body ? body.startIndex : Math.min(node.endIndex, node.startIndex + 240);
  const raw = source.slice(node.startIndex, endIndex).trim();
  return raw.split('\n')[0]?.trim().slice(0, 240) ?? '';
}

function makeSymbol(
  filePath: string,
  language: CodeLanguage,
  source: string,
  node: SyntaxNode,
  kind: CodeSymbolKind,
  name: string,
  exported: boolean
): CodeSymbol {
  const startLine = node.startPosition.row + 1;
  const endLine = Math.max(startLine, node.endPosition.row + 1);
  const signature = buildSignature(source, node);
  return {
    id: symbolId(filePath, name, startLine),
    name,
    kind,
    filePath,
    language,
    startLine,
    endLine,
    signature,
    exported,
    terms: termsFromSymbol(name, signature),
  };
}

function extractImportFromNode(source: string, node: SyntaxNode, language: CodeLanguage): string | null {
  if (language === 'typescript' || language === 'javascript') {
    const sourceNode = node.childForFieldName('source');
    if (!sourceNode) return null;
    return getNodeText(source, sourceNode).replace(/^['"]|['"]$/g, '').trim() || null;
  }

  if (language === 'python' && node.type === 'import_from_statement') {
    const moduleNode = getChildByTypes(node, ['dotted_name', 'relative_import']);
    return moduleNode ? getNodeText(source, moduleNode).trim() : null;
  }

  if (language === 'java') {
    const scoped = getChildByTypes(node, ['scoped_identifier', 'identifier']);
    return scoped ? getNodeText(source, scoped).trim() : null;
  }

  return null;
}

function visitNode(
  source: string,
  filePath: string,
  language: CodeLanguage,
  grammar: GrammarLanguage,
  node: SyntaxNode,
  symbols: CodeSymbol[],
  imports: Set<string>
): void {
  const nodeType = node.type;

  if (nodeType === 'import_statement' || nodeType === 'import_from_statement' || nodeType === 'import_declaration') {
    const importPath = extractImportFromNode(source, node, language);
    if (importPath) imports.add(importPath);
  }

  if (language === 'typescript' || language === 'javascript') {
    if (nodeType === 'class_declaration' || nodeType === 'abstract_class_declaration') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, 'class', name, isExported(node)));
    } else if (nodeType === 'interface_declaration') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, 'interface', name, isExported(node)));
    } else if (nodeType === 'type_alias_declaration') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, 'type', name, isExported(node)));
    } else if (nodeType === 'enum_declaration') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, 'enum', name, isExported(node)));
    } else if (nodeType === 'function_declaration') {
      const name = getName(node, source);
      if (name) {
        const kind = (grammar === 'tsx' || grammar === 'jsx') && isPascalCase(name) && containsJsx(node) ? 'component' : 'function';
        symbols.push(makeSymbol(filePath, language, source, node, kind, name, isExported(node)));
      }
    } else if (nodeType === 'method_definition' || nodeType === 'public_field_definition' || nodeType === 'field_definition') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, 'method', name, isExported(node)));
    } else if (nodeType === 'variable_declarator') {
      const name = getName(node, source);
      if (name) {
        const initializer = findFunctionInitializer(node);
        if (initializer) {
          const kind = (grammar === 'tsx' || grammar === 'jsx') && isPascalCase(name) && containsJsx(initializer) ? 'component' : 'function';
          symbols.push(makeSymbol(filePath, language, source, node, kind, name, isExported(node)));
        } else if (!isInsideClass(node)) {
          symbols.push(makeSymbol(filePath, language, source, node, 'variable', name, isExported(node)));
        }
      }
    }
  } else if (language === 'python') {
    if (nodeType === 'class_definition') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, 'class', name, false));
    } else if (nodeType === 'function_definition') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, isInsideClass(node) ? 'method' : 'function', name, false));
    }
  } else if (language === 'java') {
    if (nodeType === 'class_declaration') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, 'class', name, isPublicJava(node)));
    } else if (nodeType === 'interface_declaration') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, 'interface', name, isPublicJava(node)));
    } else if (nodeType === 'enum_declaration') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, 'enum', name, isPublicJava(node)));
    } else if (nodeType === 'method_declaration' || nodeType === 'constructor_declaration') {
      const name = getName(node, source);
      if (name) symbols.push(makeSymbol(filePath, language, source, node, 'method', name, isPublicJava(node)));
    }
  }

  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index);
    if (child) visitNode(source, filePath, language, grammar, child, symbols, imports);
  }
}

export function extractWithTreeSitter(
  filePath: string,
  language: CodeLanguage,
  content: string
): TreeSitterExtraction | null {
  const grammar = grammarForFile(filePath, language);
  if (!grammar) return null;

  const parser = getParser(grammar);
  if (!parser) return null;

  let tree: ReturnType<Parser['parse']> = null;
  try {
    tree = parser.parse(content);
    if (!tree) return null;

    const symbols: CodeSymbol[] = [];
    const imports = new Set<string>();
    visitNode(content, filePath, language, grammar, tree.rootNode, symbols, imports);

    return {
      symbols,
      imports: [...imports].sort(),
      errors: tree.rootNode.hasError ? [`${filePath}: parsed with syntax errors`] : [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      symbols: [],
      imports: [],
      errors: [`${filePath}: ${message}`],
    };
  } finally {
    tree?.delete();
  }
}
