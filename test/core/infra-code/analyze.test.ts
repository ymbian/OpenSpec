import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeCodeForChange, indexProjectCode } from '../../../src/core/infra-code/analyze.js';
import { getCodeModuleDetail, listCodeModules } from '../../../src/core/infra-code/query.js';

describe('infra-code analyze', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `infraspec-code-test-${randomUUID()}`);
    await fs.mkdir(path.join(testDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'infraspec', 'changes', 'add-phone-login'), { recursive: true });

    await fs.writeFile(
      path.join(testDir, 'src', 'auth.ts'),
      [
        'export function loginUser(username: string, password: string) {',
        '  return createSession(username);',
        '}',
        '',
        'export function createSession(userId: string) {',
        '  return { userId, token: `session-${userId}` };',
        '}',
        '',
        'export function sendPhoneVerificationCode(phone: string) {',
        '  return { phone, otp: "123456" };',
        '}',
        '',
        'export function verifyOtpLogin(phone: string, otp: string) {',
        '  sendPhoneVerificationCode(phone);',
        '  return createSession(phone);',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    await fs.writeFile(
      path.join(testDir, 'infraspec', 'changes', 'add-phone-login', 'requirement-description.md'),
      '支持手机号验证码登录，复用现有登录和会话创建流程。',
      'utf-8'
    );
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('builds a built-in tree-sitter JSON code graph context without codegraph dependency', async () => {
    const result = await analyzeCodeForChange({
      projectRoot: testDir,
      change: 'add-phone-login',
      maxNodes: 12,
      maxCodeBlocks: 4,
    });

    expect(result.status).toBe('ready');
    expect(result.backend).toBe('json');

    const indexPath = path.join(testDir, 'infraspec', '.code-graph', 'index.json');
    const contextPath = path.join(testDir, 'infraspec', 'changes', 'add-phone-login', 'code-context.md');
    const contextJsonPath = path.join(testDir, 'infraspec', 'changes', 'add-phone-login', '.code-context.json');

    await expect(fs.stat(indexPath)).resolves.toBeTruthy();
    await expect(fs.stat(contextPath)).resolves.toBeTruthy();
    await expect(fs.stat(contextJsonPath)).resolves.toBeTruthy();

    const markdown = await fs.readFile(contextPath, 'utf-8');
    expect(markdown).toContain('built-in tree-sitter code graph');
    expect(markdown).toMatch(/loginUser|createSession|sendPhoneVerificationCode|verifyOtpLogin/);

    const payload = JSON.parse(await fs.readFile(contextJsonPath, 'utf-8')) as {
      status: string;
      backend: string;
      context: {
        entrySymbols: unknown[];
        expandedTerms: string[];
        stats: {
          parserBackend: string;
          treeSitterFiles: number;
          regexFallbackFiles: number;
        };
      };
    };
    expect(payload.status).toBe('ready');
    expect(payload.backend).toBe('json');
    expect(payload.context.entrySymbols.length).toBeGreaterThan(0);
    expect(payload.context.expandedTerms).toContain('login');
    expect(payload.context.expandedTerms).toContain('phone');
    expect(payload.context.stats.parserBackend).toBe('tree-sitter-wasm');
    expect(payload.context.stats.treeSitterFiles).toBeGreaterThan(0);
    expect(payload.context.stats.regexFallbackFiles).toBe(0);
  });

  it('builds the global code graph index without a change name', async () => {
    const result = await indexProjectCode({
      projectRoot: testDir,
    });

    expect(result.status).toBe('ready');
    expect(result.backend).toBe('json');

    const indexPath = path.join(testDir, 'infraspec', '.code-graph', 'index.json');
    expect(result.indexPath).toBe(indexPath);
    await expect(fs.stat(indexPath)).resolves.toBeTruthy();

    const payload = JSON.parse(await fs.readFile(indexPath, 'utf-8')) as {
      files: unknown[];
      symbols: Array<{ name: string }>;
      modules: unknown[];
      entryPoints: unknown[];
      executionFlows: unknown[];
      stats: {
        fileCount: number;
        symbolCount: number;
        moduleCount: number;
        entryPointCount: number;
        executionFlowCount: number;
      };
    };

    expect(payload.files.length).toBeGreaterThan(0);
    expect(payload.stats.fileCount).toBeGreaterThan(0);
    expect(payload.stats.symbolCount).toBeGreaterThan(0);
    expect(payload.modules.length).toBe(payload.stats.moduleCount);
    expect(payload.entryPoints.length).toBe(payload.stats.entryPointCount);
    expect(payload.executionFlows.length).toBe(payload.stats.executionFlowCount);
    expect(payload.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'loginUser' }),
      expect.objectContaining({ name: 'createSession' }),
    ]));
  });

  it('ignores Java test sources and Maven target outputs in the global index', async () => {
    await fs.mkdir(path.join(testDir, 'src', 'main', 'java', 'com', 'example'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'src', 'test', 'java', 'com', 'example'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'target', 'classes', 'com', 'example'), { recursive: true });

    await fs.writeFile(
      path.join(testDir, 'src', 'main', 'java', 'com', 'example', 'OrderService.java'),
      [
        'package com.example;',
        '',
        'public class OrderService {',
        '  public String createOrder(String orderId) {',
        '    return orderId;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
    await fs.writeFile(
      path.join(testDir, 'src', 'test', 'java', 'com', 'example', 'OrderServiceTest.java'),
      [
        'package com.example;',
        '',
        'public class OrderServiceTest {',
        '  public void createsOrder() {}',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
    await fs.writeFile(
      path.join(testDir, 'target', 'classes', 'com', 'example', 'GeneratedOrderService.java'),
      [
        'package com.example;',
        '',
        'public class GeneratedOrderService {',
        '  public void generated() {}',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    const result = await indexProjectCode({ projectRoot: testDir });
    expect(result.status).toBe('ready');

    const payload = JSON.parse(await fs.readFile(result.indexPath, 'utf-8')) as {
      files: Array<{ path: string }>;
      symbols: Array<{ name: string; filePath: string }>;
    };
    const indexedFiles = payload.files.map((file) => file.path);
    const indexedSymbols = payload.symbols.map((symbol) => symbol.name);

    expect(indexedFiles).toContain('src/main/java/com/example/OrderService.java');
    expect(indexedFiles).not.toEqual(expect.arrayContaining([
      expect.stringContaining('src/test/'),
      expect.stringContaining('target/'),
    ]));
    expect(indexedSymbols).toContain('OrderService');
    expect(indexedSymbols).not.toEqual(expect.arrayContaining([
      'OrderServiceTest',
      'GeneratedOrderService',
    ]));
  });

  it('adds GitNexus-style lightweight modules, entry points, and execution flows', async () => {
    await fs.mkdir(path.join(testDir, 'src', 'controller'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'src', 'service'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'src', 'mapper'), { recursive: true });

    await fs.writeFile(
      path.join(testDir, 'src', 'controller', 'UserController.java'),
      [
        'package demo;',
        '',
        'public class UserController {',
        '  public String handleLogin(String username) {',
        '    return validateUser(username);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
    await fs.writeFile(
      path.join(testDir, 'src', 'service', 'UserService.java'),
      [
        'package demo;',
        '',
        'public class UserService {',
        '  public String validateUser(String username) {',
        '    return findUser(username);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
    await fs.writeFile(
      path.join(testDir, 'src', 'mapper', 'UserMapper.java'),
      [
        'package demo;',
        '',
        'public class UserMapper {',
        '  public String findUser(String username) {',
        '    return username;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    const result = await indexProjectCode({ projectRoot: testDir });
    expect(result.status).toBe('ready');

    const payload = JSON.parse(await fs.readFile(result.indexPath, 'utf-8')) as {
      modules: Array<{
        id: string;
        strategy: string;
        confidence: string;
        layers: string[];
        files: string[];
      }>;
      entryPoints: Array<{
        name: string;
        kind: string;
        moduleId?: string;
        confidence: string;
      }>;
      executionFlows: Array<{
        entryPointId: string;
        moduleIds: string[];
        confidence: string;
        steps: Array<{ name: string }>;
      }>;
    };

    const userModule = payload.modules.find((module) => module.id === 'user');
    expect(userModule).toEqual(expect.objectContaining({
      strategy: 'hybrid-lightweight',
      confidence: 'high',
    }));
    expect(userModule?.layers).toEqual(expect.arrayContaining(['controller', 'mapper', 'service']));
    expect(userModule?.files).toEqual(expect.arrayContaining([
      'src/controller/UserController.java',
      'src/service/UserService.java',
      'src/mapper/UserMapper.java',
    ]));

    expect(payload.entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'handleLogin',
        kind: 'controller',
        moduleId: 'user',
      }),
    ]));
    expect(payload.executionFlows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleIds: expect.arrayContaining(['user']),
        confidence: expect.stringMatching(/high|medium/),
        steps: expect.arrayContaining([
          expect.objectContaining({ name: 'handleLogin' }),
          expect.objectContaining({ name: 'validateUser' }),
          expect.objectContaining({ name: 'findUser' }),
        ]),
      }),
    ]));
  });

  it('returns context-sized module summaries and module detail slices for wiki generation', async () => {
    await fs.mkdir(path.join(testDir, 'src', 'controller'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'src', 'service'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'src', 'mapper'), { recursive: true });

    await fs.writeFile(
      path.join(testDir, 'src', 'controller', 'UserController.java'),
      [
        'package demo;',
        '',
        'public class UserController {',
        '  public String handleLogin(String username) {',
        '    return validateUser(username);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
    await fs.writeFile(
      path.join(testDir, 'src', 'service', 'UserService.java'),
      [
        'package demo;',
        '',
        'public class UserService {',
        '  public String validateUser(String username) {',
        '    return findUser(username);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
    await fs.writeFile(
      path.join(testDir, 'src', 'mapper', 'UserMapper.java'),
      [
        'package demo;',
        '',
        'public class UserMapper {',
        '  public String findUser(String username) {',
        '    return username;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    const modules = await listCodeModules({ projectRoot: testDir, refresh: true });
    expect(modules.indexGenerated).toBe(true);
    expect(modules.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'user',
        layers: expect.arrayContaining(['controller', 'mapper', 'service']),
        entryPointCount: expect.any(Number),
        executionFlowCount: expect.any(Number),
      }),
    ]));

    const detail = await getCodeModuleDetail({
      projectRoot: testDir,
      moduleId: 'user',
      maxFiles: 2,
      maxSymbols: 3,
      maxFlows: 1,
      maxEdges: 2,
    });
    expect(detail.module.id).toBe('user');
    expect(detail.files.length).toBe(2);
    expect(detail.truncated.files).toBe(true);
    expect(detail.symbols.length).toBe(3);
    expect(detail.truncated.symbols).toBe(true);
    expect(detail.entryPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'handleLogin', moduleId: 'user' }),
    ]));
    expect(detail.executionFlows.length).toBeLessThanOrEqual(1);
    expect(detail.totals.files).toBeGreaterThan(detail.files.length);
  });

  it('indexes React, Java, and Python symbols with tree-sitter', async () => {
    await fs.writeFile(
      path.join(testDir, 'src', 'LoginPanel.tsx'),
      [
        'export const LoginPanel = () => {',
        '  return <button>Phone login</button>;',
        '};',
        '',
        'export function usePhoneLogin() {',
        '  return verifyOtpLogin;',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
    await fs.writeFile(
      path.join(testDir, 'src', 'LoginService.java'),
      [
        'package demo;',
        '',
        'public class LoginService {',
        '  public String verifyPhoneLogin(String phone, String otp) {',
        '    return createSession(phone);',
        '  }',
        '',
        '  private String createSession(String user) {',
        '    return user;',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );
    await fs.writeFile(
      path.join(testDir, 'src', 'phone_login.py'),
      [
        'class PhoneLoginService:',
        '    def verify_phone_login(self, phone, otp):',
        '        return create_session(phone)',
        '',
        'def create_session(user_id):',
        '    return {"user_id": user_id}',
        '',
      ].join('\n'),
      'utf-8'
    );

    const result = await analyzeCodeForChange({
      projectRoot: testDir,
      change: 'add-phone-login',
      maxNodes: 20,
      maxCodeBlocks: 8,
    });

    expect(result.status).toBe('ready');

    const contextJsonPath = path.join(testDir, 'infraspec', 'changes', 'add-phone-login', '.code-context.json');
    const payload = JSON.parse(await fs.readFile(contextJsonPath, 'utf-8')) as {
      context: {
        entrySymbols: Array<{ symbol: { name: string; kind: string; language: string } }>;
        relatedSymbols: Array<{ symbol: { name: string; kind: string; language: string } }>;
        stats: {
          parserBackend: string;
          treeSitterFiles: number;
          regexFallbackFiles: number;
        };
      };
    };
    const symbols = [...payload.context.entrySymbols, ...payload.context.relatedSymbols].map((item) => item.symbol);

    expect(payload.context.stats.parserBackend).toBe('tree-sitter-wasm');
    expect(payload.context.stats.treeSitterFiles).toBeGreaterThanOrEqual(4);
    expect(payload.context.stats.regexFallbackFiles).toBe(0);
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'LoginPanel', kind: 'component', language: 'typescript' }),
      expect.objectContaining({ name: 'LoginService', language: 'java' }),
      expect.objectContaining({ name: 'PhoneLoginService', language: 'python' }),
    ]));
  });
});
