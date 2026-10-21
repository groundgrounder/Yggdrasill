import {parse, stringify} from 'yaml';

export function parseYaml(text) {
  const value = parse(text, {uniqueKeys: true, maxAliasCount: 100});
  const ancestors = new Set();
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (ancestors.has(node)) throw new Error('YAML 不能含循环别名');
    ancestors.add(node);
    Object.values(node).forEach(visit);
    ancestors.delete(node);
  }
  visit(value);
  return value;
}

export const stringifyYaml = value => stringify(value);
