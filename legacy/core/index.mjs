// 世界树内核入口。
export * as contract from './contract.mjs';
export {SPEC_VERSION, PLAYER} from './contract.mjs';
export {createDialect, createCalendar, createRanks, isDialect, requireDialect} from './dialect.mjs';
export {parseYaml, stringifyYaml, setYamlProvider, yamlProvider, unwrap} from './yaml.mjs';
export {loadCatalog, parentFromPath} from './catalog.mjs';
export {evaluateCondition, conditionReferences, requiredEventIDs, prerequisitesPossible, analyzeEvents, checkStorylines} from './relations.mjs';
export {selectEventContext, eventContextDefaults, serializedChars} from './context.mjs';
export {abilityChangeIssues, growthIssues, traitsIssues, abilityFields} from './growth.mjs';
export {profileFormatIssues, groupIndexFormatIssues} from './profile-format.mjs';
export {createProtocol, eventRange, sceneGateIssues, applyChanges, confirmEvent, confirmDynamicEvent, confirmInitialGrowth, seal, assemble, assembleWithAudit, strip} from './protocol.mjs';

import fs from 'node:fs/promises';
import path from 'node:path';
import {createDialect} from './dialect.mjs';
import {loadCatalog} from './catalog.mjs';
import {parseYaml} from './yaml.mjs';

// 读取项目方言：yggdrasill.yaml 位于项目根；世界书根默认取其“世界书”键。
export async function readDialect(file) {
  const config = await parseYaml(await fs.readFile(file, 'utf8'));
  return createDialect(config);
}

// 自世界书根向上查找 yggdrasill.yaml。
export async function findDialectFile(start) {
  for (let dir = path.resolve(start), guard = 0; guard < 64; guard++) {
    const file = path.join(dir, 'yggdrasill.yaml');
    if (await fs.access(file).then(() => true, () => false)) return file;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

export async function openWorldbook(root, {dialect, dialectFile} = {}) {
  dialectFile ??= dialect ? null : await findDialectFile(root);
  if (!dialect && !dialectFile) throw new Error('未找到 yggdrasill.yaml：' + root);
  dialect ??= await readDialect(dialectFile);
  const catalog = await loadCatalog(root, parseYaml, fs, path);
  return {root, dialect, dialectFile, catalog};
}
