export const has = (value, key) => value != null && Object.hasOwn(value, key);
export const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isText = value => typeof value === 'string' && value.trim().length > 0;
export const texts = (value, allowEmpty = false) => Array.isArray(value) && (allowEmpty || value.length > 0)
  && value.every(isText) && new Set(value).size === value.length;
export const pairs = value => isMap(value) ? Object.entries(value) : [];
export const list = value => Array.isArray(value) ? value : [];
export const dict = value => Object.fromEntries(pairs(value));
export const count = value => [...value.replace(/\s/gu, '')].length;
export const matches = (value, conditions) => isMap(value) && isMap(conditions)
  && Object.entries(conditions).every(([key, expected]) => has(value, key) && value[key] === expected);

export function codepointCompare(left, right) {
  const first = Array.from(left, value => value.codePointAt(0)), second = Array.from(right, value => value.codePointAt(0));
  for (let index = 0; index < Math.min(first.length, second.length); index++) if (first[index] !== second[index]) return first[index] - second[index];
  return first.length - second.length;
}

export function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function issue(rule, level, file, message) {
  return {规则: rule, 级别: level, 文件: file, 说明: message};
}
