const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'will', 'would',
  'could', 'should', 'does', 'make', 'made', 'use', 'used', 'using', 'work',
  'works', 'find', 'show', 'get', 'set', 'add', 'all', 'any', 'how', 'what',
  'when', 'where', 'which', 'who', 'why', 'not', 'but', 'are', 'was', 'were',
  'has', 'had', 'can', 'did', 'may', 'also', 'into', 'then', 'than', 'them',
  'need', 'needs', 'want', 'wants', 'change', 'changes', 'changed', 'code',
  'function', 'feature', 'module', 'system', 'support', 'supports',
]);

const CHINESE_TECH_TERMS: Array<[string, string[]]> = [
  ['登录', ['login', 'signin', 'signIn', 'auth', 'authentication', 'session']],
  ['登陆', ['login', 'signin', 'signIn', 'auth', 'authentication', 'session']],
  ['认证', ['auth', 'authentication', 'authorize', 'authorization']],
  ['鉴权', ['auth', 'authorize', 'permission', 'access']],
  ['授权', ['authorize', 'authorization', 'permission', 'access']],
  ['手机号', ['phone', 'mobile', 'tel', 'sms']],
  ['手机', ['phone', 'mobile', 'sms']],
  ['验证码', ['code', 'otp', 'verification', 'verify']],
  ['短信', ['sms', 'message', 'verification']],
  ['会话', ['session', 'token', 'cookie']],
  ['用户', ['user', 'account', 'member']],
  ['账号', ['account', 'user', 'profile']],
  ['密码', ['password', 'credential']],
  ['订单', ['order', 'checkout', 'purchase']],
  ['支付', ['payment', 'pay', 'checkout']],
  ['退款', ['refund', 'reversal']],
  ['权限', ['permission', 'role', 'access', 'auth']],
  ['角色', ['role', 'permission']],
  ['配置', ['config', 'configuration', 'setting', 'settings']],
  ['搜索', ['search', 'query', 'filter']],
  ['查询', ['query', 'search', 'find', 'fetch']],
  ['列表', ['list', 'items', 'table']],
  ['详情', ['detail', 'details', 'profile']],
  ['创建', ['create', 'add', 'new']],
  ['新增', ['create', 'add', 'new']],
  ['编辑', ['edit', 'update', 'modify']],
  ['修改', ['update', 'edit', 'modify']],
  ['删除', ['delete', 'remove', 'destroy']],
  ['导入', ['import', 'upload']],
  ['导出', ['export', 'download']],
  ['上传', ['upload']],
  ['下载', ['download']],
  ['通知', ['notification', 'notify', 'message']],
  ['消息', ['message', 'notification']],
  ['缓存', ['cache', 'caching']],
  ['任务', ['task', 'job', 'worker']],
  ['审批', ['approval', 'approve', 'review']],
  ['流程', ['workflow', 'flow', 'process']],
];

function splitCompound(value: string): string[] {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_./\\:-]+/g, ' ');

  return spaced
    .split(/[^A-Za-z0-9\u4e00-\u9fff]+/u)
    .filter(Boolean);
}

export function uniqueTerms(terms: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const term of terms) {
    const normalized = term.trim();
    if (!normalized) continue;
    const lower = /[A-Za-z]/.test(normalized) ? normalized.toLowerCase() : normalized;
    if (lower.length < 2 && !/[\u4e00-\u9fff]/u.test(lower)) continue;
    if (STOP_WORDS.has(lower)) continue;
    seen.add(lower);
  }
  return [...seen];
}

export function extractTerms(value: string): string[] {
  const terms: string[] = [];
  terms.push(...splitCompound(value));

  const identifierMatches = value.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const match of identifierMatches) {
    terms.push(match);
    terms.push(...splitCompound(match));
  }

  const chineseMatches = value.match(/[\u4e00-\u9fff]{2,}/gu) ?? [];
  terms.push(...chineseMatches);

  return uniqueTerms(terms);
}

export function expandRequirementTerms(requirement: string): string[] {
  const expanded = new Set(extractTerms(requirement));
  const lowerRequirement = requirement.toLowerCase();

  for (const [chinese, englishTerms] of CHINESE_TECH_TERMS) {
    if (requirement.includes(chinese)) {
      for (const term of englishTerms) {
        expanded.add(term.toLowerCase());
        for (const split of splitCompound(term)) {
          expanded.add(split.toLowerCase());
        }
      }
    }
  }

  // Common English aliases that help bridge product wording to code symbols.
  if (lowerRequirement.includes('sign in') || lowerRequirement.includes('signin')) {
    expanded.add('login');
    expanded.add('auth');
    expanded.add('session');
  }
  if (lowerRequirement.includes('phone') || lowerRequirement.includes('mobile')) {
    expanded.add('sms');
    expanded.add('verification');
  }

  return uniqueTerms(expanded);
}

export function termsFromPath(filePath: string): string[] {
  return extractTerms(filePath.replace(/\.[^.]+$/u, ''));
}

export function termsFromSymbol(name: string, signature?: string): string[] {
  return uniqueTerms([
    name,
    ...extractTerms(name),
    ...(signature ? extractTerms(signature) : []),
  ]);
}
