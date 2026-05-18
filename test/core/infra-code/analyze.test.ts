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

  it('builds a built-in JSON code graph context without codegraph dependency', async () => {
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
    expect(markdown).toContain('built-in lightweight code graph');
    expect(markdown).toMatch(/loginUser|createSession|sendPhoneVerificationCode|verifyOtpLogin/);

    const payload = JSON.parse(await fs.readFile(contextJsonPath, 'utf-8')) as {
      status: string;
      backend: string;
      context: {
        entrySymbols: unknown[];
        expandedTerms: string[];
      };
    };
    expect(payload.status).toBe('ready');
    expect(payload.backend).toBe('json');
    expect(payload.context.entrySymbols.length).toBeGreaterThan(0);
    expect(payload.context.expandedTerms).toContain('login');
    expect(payload.context.expandedTerms).toContain('phone');
  });
});
