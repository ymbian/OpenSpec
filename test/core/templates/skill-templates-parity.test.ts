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
  getApplyChangeSkillTemplate: '9e9a8d40fd045400405fd5f47d70529af3cd4602eb4bc8aa6fb4730575385b6e',
  getFfChangeSkillTemplate: '746130edb8ff3587ca7ec1e6d0e280d47c8cd2ff079aad48046cc1f58141a582',
  getSyncSpecsSkillTemplate: '12e3db4b355b8555a252853047ff2251348d402099373ba2b560a99e441efebd',
  getOnboardSkillTemplate: '48f2b8bab5d71095091eee06ddc2868bb34ae85820642d605d3506121268f1dc',
  getOpsxExploreCommandTemplate: '42b8c2ee093351ddd9f6a3ee70da12aa746e8cf27398d7f2668b883d66a1739f',
  getOpsxNewCommandTemplate: 'da538ae5ea6fcd11d733bd842eac1d4590fa1106e2505b8baae035063543140d',
  getOpsxContinueCommandTemplate: '478707f69fcdfcdee416bdcc1b119de4d21147fef294041fb2adbae51ec3bbeb',
  getOpsxApplyCommandTemplate: 'b9ff761a93fa60d4cd89127f1cc1b6253759999eb3f0c89d4036ebe0f2c37af3',
  getOpsxFfCommandTemplate: '1401eb941a912300653dfd1dbead4df72f9c694db3bd1c0ca1d202d05cbd8165',
  getArchiveChangeSkillTemplate: 'b54ce4e2da00b504f7038ead8b27ae126461c8bb82ba05237673f5b39e1e53f1',
  getBulkArchiveChangeSkillTemplate: '22599a0eee14ef599abeeae9e946b7e0483a2bf5fa20f9c560629d0200447c0c',
  getOpsxSyncCommandTemplate: '6e6f4b46f0f6f2de54d9c04b6e9ce59c91eb2ea0ea67cbb872ad2d72746b69fc',
  getVerifyChangeSkillTemplate: '763d6d5766e07dbdfeca694ba418b46c9c89db5b9b9197d09ccda84c334f2794',
  getOpsxArchiveCommandTemplate: 'b5ad445d5b543c638a32ec17dbf0efbb245165d971f456ebdea5913305ffa8ab',
  getOpsxOnboardCommandTemplate: '1033ca3baeb6af9f335b838bf9651116e0d2757a79d151fbe021dadef063636c',
  getOpsxBulkArchiveCommandTemplate: 'e0b65e71559daf7a7cbaa0d5e7b6b14970abaf0d469249ee74711503fcf4f332',
  getOpsxVerifyCommandTemplate: '6901da5a61f1a3df31a9c4a80e0c6c8e43616ab452594ac89a2138c738a73e24',
  getOpsxProposeSkillTemplate: '0114b9efcfe525dbbfe344b851f9bc6497be286a6b9f01cdd39c93d9ac2a0e5b',
  getOpsxProposeCommandTemplate: '8a5e080fd386c9d436b07df5b0fb7c5a57724516f637b8e2f5c0a98d2eab42c2',
  getWikiSkillTemplate: '0032b65a43595eeaa2206a59f057e3042d0a77eb819b572cb8eae6da4c4510bd',
  getOpsxWikiCommandTemplate: '7e5b22f1584093350bdf1128199ded1b369913afc5db5ba58407704c2cda86bf',
  getFeedbackSkillTemplate: '60edf11efed5d4b57dc54a1d361dda030a9c38125dfb790669492ae31bd5fc75',
};

const EXPECTED_GENERATED_SKILL_CONTENT_HASHES: Record<string, string> = {
  'infra-explore': '2feef9c76a3a381ac6adae0bc36e1056cf2d37581029a44d912b6c1643a4e034',
  'infra-new-change': '3af86310f87a2ac048dc17bc0562120603d77d42f6d0b55f76997558d33854b5',
  'infra-continue-change': '3ed8982eccc57541f87d112cb5e10ffa0b4efebb40011dfa903b612b3bdfc605',
  'infra-apply-change': '76865c38e5112a4bd605f8e168360a3fc395fe49cd86986489ca46e3c1960038',
  'infra-ff-change': 'ea281ab29b36c6832dc32760fbbe74c433239f85e6109d01ba72dabc8ec57506',
  'infra-sync-specs': '81fdf2ca4085f0e8ebea4ba0aad28a54d3139507898ebd88dd1177bb224978f5',
  'infra-archive-change': '3dcd3f486c37ae0b3744d3a1be56afc95a1044a359ee8c1719e07f03420a99bf',
  'infra-bulk-archive-change': '741933753e92737917197169f30204202e94994a6b18133779807eca53fd13c5',
  'infra-verify-change': 'bfdd5810549d7a25107125e55cd1c91ee1fcd6c7eec025584ddf521aae618b69',
  'infra-onboard': 'cf7678748d433f98aef2bc055b223111ad6849c1d7affe73488e7cdbe144b4ad',
  'infra-propose': '71b91a3a5b0826578a4861b0f93ce77799b3042962a9c8fa9e49f4e8a55fea71',
  'infra-wiki': 'fa9c5c09f8249a937e114db1a6c77152f082eef5a0d76bfd9bea28fdd4eb218b',
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
