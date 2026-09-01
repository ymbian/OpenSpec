import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  type SkillTemplate,
  getApplyChangeSkillTemplate,
  getArchiveChangeSkillTemplate,
  getBulkArchiveChangeSkillTemplate,
  getContinueChangeSkillTemplate,
  getExploreSkillTemplate,
  getFeedbackSkillTemplate,
  getFfChangeSkillTemplate,
  getNewChangeSkillTemplate,
  getOnboardSkillTemplate,
  getOpsxApplyCommandTemplate,
  getOpsxArchiveCommandTemplate,
  getOpsxBulkArchiveCommandTemplate,
  getOpsxContinueCommandTemplate,
  getOpsxExploreCommandTemplate,
  getOpsxFfCommandTemplate,
  getOpsxNewCommandTemplate,
  getOpsxOnboardCommandTemplate,
  getOpsxSyncCommandTemplate,
  getOpsxWikiCommandTemplate,
  getOpsxProposeCommandTemplate,
  getOpsxProposeSkillTemplate,
  getOpsxVerifyCommandTemplate,
  getSyncSpecsSkillTemplate,
  getWikiSkillTemplate,
  getVerifyChangeSkillTemplate,
} from '../../../src/core/templates/skill-templates.js';
import { generateSkillContent } from '../../../src/core/shared/skill-generation.js';

const EXPECTED_FUNCTION_HASHES: Record<string, string> = {
  getExploreSkillTemplate: 'ac74a5d3885343a7711c18f33eb0ea8436f2dfdc08be47bd0909f6699c689e5f',
  getNewChangeSkillTemplate: '30e2f5e6d8f9fb8f875f4f4f8372aa74668dfa467bf2341d0c33059f4127e3ae',
  getContinueChangeSkillTemplate: '86f0e3573df058e8f17f47798cf1bed9cd2af22f08ca3d07ca7d04c2e3cd9467',
  getApplyChangeSkillTemplate: 'd14e51a950c3372310d502e1ab9fe16cc5bb75ef5c1c552cfa2e664ce471749f',
  getFfChangeSkillTemplate: '746130edb8ff3587ca7ec1e6d0e280d47c8cd2ff079aad48046cc1f58141a582',
  getSyncSpecsSkillTemplate: '12e3db4b355b8555a252853047ff2251348d402099373ba2b560a99e441efebd',
  getOnboardSkillTemplate: '48f2b8bab5d71095091eee06ddc2868bb34ae85820642d605d3506121268f1dc',
  getOpsxExploreCommandTemplate: '42b8c2ee093351ddd9f6a3ee70da12aa746e8cf27398d7f2668b883d66a1739f',
  getOpsxNewCommandTemplate: 'da538ae5ea6fcd11d733bd842eac1d4590fa1106e2505b8baae035063543140d',
  getOpsxContinueCommandTemplate: '478707f69fcdfcdee416bdcc1b119de4d21147fef294041fb2adbae51ec3bbeb',
  getOpsxApplyCommandTemplate: '1fcd872244e07651cbac773f16db08bee20ab28af7b6226a3faf95eba878cc30',
  getOpsxFfCommandTemplate: '1401eb941a912300653dfd1dbead4df72f9c694db3bd1c0ca1d202d05cbd8165',
  getArchiveChangeSkillTemplate: 'b54ce4e2da00b504f7038ead8b27ae126461c8bb82ba05237673f5b39e1e53f1',
  getBulkArchiveChangeSkillTemplate: '22599a0eee14ef599abeeae9e946b7e0483a2bf5fa20f9c560629d0200447c0c',
  getOpsxSyncCommandTemplate: '6e6f4b46f0f6f2de54d9c04b6e9ce59c91eb2ea0ea67cbb872ad2d72746b69fc',
  getVerifyChangeSkillTemplate: '763d6d5766e07dbdfeca694ba418b46c9c89db5b9b9197d09ccda84c334f2794',
  getOpsxArchiveCommandTemplate: 'b5ad445d5b543c638a32ec17dbf0efbb245165d971f456ebdea5913305ffa8ab',
  getOpsxOnboardCommandTemplate: '1033ca3baeb6af9f335b838bf9651116e0d2757a79d151fbe021dadef063636c',
  getOpsxBulkArchiveCommandTemplate: 'e0b65e71559daf7a7cbaa0d5e7b6b14970abaf0d469249ee74711503fcf4f332',
  getOpsxVerifyCommandTemplate: '6901da5a61f1a3df31a9c4a80e0c6c8e43616ab452594ac89a2138c738a73e24',
  getOpsxProposeSkillTemplate: '2bdc1bf5f747820408872e33a02937e2660632564e242d668b7b293b85998d93',
  getOpsxProposeCommandTemplate: '5fa89a0578f1ca07908bd8bb5dbccc831aecaabf31c39f964ebc8ba8b6a5e941',
  getWikiSkillTemplate: '0032b65a43595eeaa2206a59f057e3042d0a77eb819b572cb8eae6da4c4510bd',
  getOpsxWikiCommandTemplate: '7e5b22f1584093350bdf1128199ded1b369913afc5db5ba58407704c2cda86bf',
  getFeedbackSkillTemplate: '60edf11efed5d4b57dc54a1d361dda030a9c38125dfb790669492ae31bd5fc75',
};

const EXPECTED_GENERATED_SKILL_CONTENT_HASHES: Record<string, string> = {
  'infra-explore': '964ddad27e5abd084a9c20ea80cd56b2eaa95574a9dd7d880cc02eed9a466010',
  'infra-new-change': 'ec6c7c28dafdbf7785f081db70126462d33a6ee7775dfb5a543ec8ff7fad222d',
  'infra-continue-change': 'bf75f6c2f8306df232464d9a5804c79c29e0eb5b3b3c8ebe115a220c3dd69601',
  'infra-apply-change': 'f4d6dc2729c2b3bea866f0b498d0ddb1378c2a2528175730fa8fdc33ffb13ac7',
  'infra-ff-change': '61b2eee75ef0efe6fe7f00b2c3bbaf7ace305146edeae0f8a883c1c6bf6585e9',
  'infra-sync-specs': '07705eaea9982c17865acb2bbdc7235584197cbed40181afb79d800bf0c10f04',
  'infra-archive-change': '5af96fda55962a5c4a81abb1766e46e071f77e954f07bbb2be0b304dd84ddf8d',
  'infra-bulk-archive-change': '83e8226206f933f1cf8df6a4016558406b92396a381123c39af2778a8550d0dd',
  'infra-verify-change': '14ffcd44a2fa763ab7a90fa2cd882a0dcbf13310a976e28cbbebbb8eed938f7d',
  'infra-onboard': 'b8326d9a8cc4263513eb215969fa060db71b6e1bcade18dba7d6b3ddd10ac5c7',
  'infra-propose': 'df43446a8f1329d56aa2f30eb4387fa62e57159c2bfbb7178b32822530af5919',
  'infra-wiki': 'dd0e298cf808c734748da4f4aa2b1e4cc9d07e42ac98e9f1f1a101fafdca2bbd',
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('skill templates split parity', () => {
  it('preserves all template function payloads exactly', () => {
    const functionFactories: Record<string, () => unknown> = {
      getExploreSkillTemplate,
      getNewChangeSkillTemplate,
      getContinueChangeSkillTemplate,
      getApplyChangeSkillTemplate,
      getFfChangeSkillTemplate,
      getSyncSpecsSkillTemplate,
      getOnboardSkillTemplate,
      getOpsxExploreCommandTemplate,
      getOpsxNewCommandTemplate,
      getOpsxContinueCommandTemplate,
      getOpsxApplyCommandTemplate,
      getOpsxFfCommandTemplate,
      getArchiveChangeSkillTemplate,
      getBulkArchiveChangeSkillTemplate,
      getOpsxSyncCommandTemplate,
      getVerifyChangeSkillTemplate,
      getOpsxArchiveCommandTemplate,
      getOpsxOnboardCommandTemplate,
      getOpsxBulkArchiveCommandTemplate,
      getOpsxVerifyCommandTemplate,
      getOpsxProposeSkillTemplate,
      getOpsxProposeCommandTemplate,
      getWikiSkillTemplate,
      getOpsxWikiCommandTemplate,
      getFeedbackSkillTemplate,
    };

    const actualHashes = Object.fromEntries(
      Object.entries(functionFactories).map(([name, fn]) => [name, hash(stableStringify(fn()))])
    );

    expect(actualHashes).toEqual(EXPECTED_FUNCTION_HASHES);
  });

  it('preserves generated skill file content exactly', () => {
    // Intentionally excludes getFeedbackSkillTemplate: skillFactories only models templates
    // deployed via generateSkillContent, while feedback is covered in function payload parity.
    const skillFactories: Array<[string, () => SkillTemplate]> = [
      ['infra-explore', getExploreSkillTemplate],
      ['infra-new-change', getNewChangeSkillTemplate],
      ['infra-continue-change', getContinueChangeSkillTemplate],
      ['infra-apply-change', getApplyChangeSkillTemplate],
      ['infra-ff-change', getFfChangeSkillTemplate],
      ['infra-sync-specs', getSyncSpecsSkillTemplate],
      ['infra-archive-change', getArchiveChangeSkillTemplate],
      ['infra-bulk-archive-change', getBulkArchiveChangeSkillTemplate],
      ['infra-verify-change', getVerifyChangeSkillTemplate],
      ['infra-onboard', getOnboardSkillTemplate],
      ['infra-propose', getOpsxProposeSkillTemplate],
      ['infra-wiki', getWikiSkillTemplate],
    ];

    const actualHashes = Object.fromEntries(
      skillFactories.map(([dirName, createTemplate]) => [
        dirName,
        hash(generateSkillContent(createTemplate(), 'PARITY-BASELINE')),
      ])
    );

    expect(actualHashes).toEqual(EXPECTED_GENERATED_SKILL_CONTENT_HASHES);
  });
});
