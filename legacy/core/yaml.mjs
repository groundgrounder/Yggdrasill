// YAML 读写入口。默认使用依赖包 yaml（严格唯一键）；宿主可用 setYamlProvider 注入兼容实现。
let provider;

export function setYamlProvider(next) {
  if (!next || typeof next.parse !== 'function' || typeof next.stringify !== 'function') throw new Error('YAML 提供者须有 parse 与 stringify');
  provider = Promise.resolve(next);
}

export function yamlProvider() {
  return provider ??= import('yaml').then(m => m.default ?? m, () => {
    throw new Error('缺少 YAML 解析器：请在世界树目录执行 npm install，或由宿主调用 setYamlProvider');
  });
}

export async function parseYaml(text) {
  return (await yamlProvider()).parse(text, {uniqueKeys: true});
}

export async function stringifyYaml(value) {
  return (await yamlProvider()).stringify(value);
}

// 包裹标签只占独立一行，读取正文时剥离。
export const unwrap = raw => String(raw).replace(/^\s*<\/?[^>\n]+>\s*$/gm, '');
