// 内存文件系统：运行时只能访问固定的 /项目 根。缺失文件、缺失目录、路径逃逸与规范化后重复都会中止。
const ROOT = '/项目';

const pathError = message => {
  const error = new Error(message);
  error.code = '路径.逃逸';
  return error;
};

function normalize(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) throw pathError(`非法运行时路径：${String(value)}`);
  if (!value.startsWith('/')) throw pathError(`运行时路径须从 ${ROOT} 开始：${value}`);
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length || (parts.length === 1 && parts[0] !== ROOT.slice(1))) throw pathError(`路径逃出运行时根：${value}`);
      parts.pop();
    } else parts.push(part);
  }
  const normalized = `/${parts.join('/')}`;
  if (normalized !== ROOT && !normalized.startsWith(`${ROOT}/`)) throw pathError(`路径不在运行时根 ${ROOT} 内：${value}`);
  return normalized;
}

export const memPath = {
  join: (...parts) => {
    const value = parts.filter(part => part !== '').join('/');
    if (value.startsWith('/')) return normalize(value);
    if (!value || value.includes('\0') || value.includes('\\')) throw pathError(`非法相对路径：${String(value)}`);
    const relative = value.split('/').filter(part => part !== '.' && part !== '');
    if (relative.some(part => part === '..')) throw pathError(`相对路径含 ..：${value}`);
    return relative.join('/');
  },
  resolve: (...parts) => normalize(parts.reduce((base, part) => part.startsWith('/') ? part : `${base}/${part}`, '/')),
  dirname: value => {
    const normalized = normalize(value), index = normalized.lastIndexOf('/');
    return index <= 0 || normalized === ROOT ? '/' : normalized.slice(0, index);
  },
  extname: value => {
    if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) throw pathError(`非法文件路径：${String(value)}`);
    if (value.split('/').some(part => part === '..')) throw pathError(`文件路径含 ..：${value}`);
    const name = value.slice(value.lastIndexOf('/') + 1), index = name.lastIndexOf('.');
    return index <= 0 ? '' : name.slice(index);
  },
};

const notFound = file => Object.assign(new Error(`ENOENT: ${file}`), {code: 'ENOENT'});

export function createMemFs(files) {
  if (files === null || typeof files !== 'object' || Array.isArray(files)) throw pathError('内存文件表须为路径到文本的映射');
  const table = new Map();
  for (const [file, text] of Object.entries(files)) {
    const key = normalize(file);
    if (key === ROOT) throw pathError(`内存文件不能占用运行时根：${file}`);
    if (typeof text !== 'string') throw pathError(`内存文件内容须为文本：${file}`);
    if (table.has(key)) throw pathError(`规范化路径重复：${key}`);
    table.set(key, text);
  }
  return {
    async readFile(file) {
      const key = normalize(file);
      if (!table.has(key)) throw notFound(key);
      return table.get(key);
    },
    async readdir(directory) {
      const root = normalize(directory);
      const prefix = `${root.replace(/\/$/, '')}/`;
      const entries = new Map();
      for (const key of table.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length), index = rest.indexOf('/');
        const name = index < 0 ? rest : rest.slice(0, index);
        if (!entries.has(name)) entries.set(name, index < 0 ? 'file' : 'directory');
      }
      if (!entries.size) throw notFound(root);
      return [...entries].map(([name, kind]) => ({name, isFile: () => kind === 'file', isDirectory: () => kind === 'directory'}));
    },
  };
}
