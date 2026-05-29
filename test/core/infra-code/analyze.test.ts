import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analyzeCodeForChange } from '../../../src/core/infra-code/analyze.js';

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
