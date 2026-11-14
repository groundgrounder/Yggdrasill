// 与结构化克隆一致的数据范围：空值、文本、布尔、有限的数、列表与普通映射，且无环。
// 普通对象按原型链的形状认，不比较 Object.prototype 本身：宿主可能在另一个 realm 中解析出本局。
export function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

export function valueProblem(value, stack = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'type';
  if (typeof value !== 'object' || (!Array.isArray(value) && !plainObject(value))) return 'type';
  if (stack.has(value)) return 'cycle';
  stack.add(value);
  for (const item of Object.values(value)) {
    const problem = valueProblem(item, stack);
    if (problem) { stack.delete(value); return problem; }
  }
  stack.delete(value);
  return null;
}

export const valueText = {
  type: '值须由映射、列表、文本、布尔、有限的数与空值组成',
  cycle: '值须由无环的数据组成',
};

export const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
