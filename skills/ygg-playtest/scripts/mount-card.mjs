#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const USAGE = `用法：node mount-card.mjs <角色卡JSON> --probe [--disable-group <角色组ID>]... [--json]

选项：
  --probe                        只读挂载打包卡并输出结构基线、默认档案（D1）与停用影响（D4）
  --disable-group <角色组ID>     指定停用的角色组 ID 以静态测算事件树直接/级联停摆面（可重复传入）
  --json                         以纯 JSON 输出探针结果（不含宿主机绝对路径）
  -h, --help                     显示本帮助信息

示例：
  node mount-card.mjs ./adapter/dist/角色卡.json --probe
  node mount-card.mjs ./adapter/dist/角色卡.json --probe --disable-group 主角组 --json
`;

const LEGACY_SYMBOLS = [
  'bundle_generated_default',
  'bundle',
  'manifest',
  'loaded',
  'catalog',
  'decl',
  'settings',
  'protocol',
  'router',
  'quietRouter',
  'keeper',
  'createOpeningDraft',
  'openingNode',
  'runKeeperLoop',
  'buildKeepRecord',
  'repairRecord',
  'callKeeper',
  'generateOpening',
  'parseJson',
  'applyCommands',
  'route',
  'renderContext',
  'stringifyYaml',
  'createCalendar',
  'evaluateCondition',
  'conditionReferences',
  'seal',
];

const GROUP_DEP_TYPES = new Set(['角色启用', '角色版本', '角色已出场', '角色状态', '同处']);
const COMBINATORS = new Set(['all', 'any', 'none']);
const COMPOUND_NAME_RE = /[与及暨]/u;

let mountCounter = 0;

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

function compareCodePoints(left, right) {
  const a = [...left];
  const b = [...right];
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = a[i].codePointAt(0) - b[i].codePointAt(0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function createDomNode(tag = 'div') {
  const self = {
    tag: String(tag),
    children: [],
    value: '',
    classes: [],
    handlers: {},
    field: undefined,
    properties: {},
    attrs: {},
    shown: true,
  };
  return Object.assign(self, {
    css: () => self,
    attr: (key, value) => {
      if (key && typeof key === 'object') {
        Object.assign(self.attrs, key);
        return self;
      }
      if (value === undefined) return self.attrs[key];
      self.attrs[key] = value;
      return self;
    },
    remove: () => self,
    prop: (key, value) => {
      if (key && typeof key === 'object') {
        Object.assign(self.properties, key);
        return self;
      }
      if (value === undefined) return self.properties[key];
      self.properties[key] = value;
      return self;
    },
    addClass: names => {
      for (const name of String(names ?? '').split(/\s+/u).filter(Boolean)) {
        if (!self.classes.includes(name)) self.classes.push(name);
      }
      return self;
    },
    removeClass: names => {
      const drop = new Set(String(names ?? '').split(/\s+/u).filter(Boolean));
      self.classes = self.classes.filter(name => !drop.has(name));
      return self;
    },
    val: value => {
      if (value === undefined) return self.field;
      self.field = value;
      return self;
    },
    on: (type, fn) => {
      self.handlers[type] = fn;
      return self;
    },
    off: type => {
      if (type) delete self.handlers[type];
      else self.handlers = {};
      return self;
    },
    trigger: (type, ...args) => {
      if (typeof self.handlers[type] === 'function') self.handlers[type](...args);
      return self;
    },
    toggle: shown => {
      self.shown = Boolean(shown);
      return self;
    },
    hide: () => self.toggle(false),
    show: () => self.toggle(true),
    empty: () => {
      self.children = [];
      return self;
    },
    append: (...children) => {
      self.children.push(...children.flat(Infinity).filter(Boolean));
      return self;
    },
    prepend: (...children) => {
      self.children.unshift(...children.flat(Infinity).filter(Boolean));
      return self;
    },
    text: value => {
      if (value === undefined) {
        return [self.value, ...self.children.map(child => (typeof child?.text === 'function' ? child.text() : String(child ?? '')))]
          .filter(Boolean)
          .join('\n');
      }
      self.value = String(value);
      return self;
    },
    html: value => {
      if (value === undefined) return self.text();
      self.value = String(value);
      return self;
    },
  });
}

function findNode(root, predicate) {
  if (!root || typeof predicate !== 'function') return undefined;
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    if (child && typeof child === 'object') {
      const hit = findNode(child, predicate);
      if (hit) return hit;
    }
  }
  return undefined;
}

function findAllNodes(root, predicate, acc = []) {
  if (!root || typeof predicate !== 'function') return acc;
  if (predicate(root)) acc.push(root);
  for (const child of root.children ?? []) {
    if (child && typeof child === 'object') findAllNodes(child, predicate, acc);
  }
  return acc;
}

function createHostEnvironment(options = {}) {
  const globals = structuredClone(options.initialGlobals ?? {});
  const calls = [];
  const toasts = [];
  const responseQueue = [];
  const chatId = typeof options.chatId === 'string' && options.chatId ? options.chatId : 'ygg-playtest-chat';
  const injected = new Map();
  const listeners = new Map();

  const pushResponse = (...responses) => {
    responseQueue.push(...responses);
  };
  const clearResponses = () => {
    responseQueue.length = 0;
  };

  const styleElements = new Map();
  const documentStub = {
    head: {
      appendChild: el => {
        if (el?.id) styleElements.set(el.id, el);
        return el;
      },
      querySelector: () => null,
    },
    body: {appendChild: el => el},
    getElementById: id => styleElements.get(id) ?? null,
    createElement: tag => ({
      tagName: String(tag).toUpperCase(),
      id: '',
      textContent: '',
      style: {},
      setAttribute: () => {},
      appendChild: child => child,
      remove: () => {},
    }),
  };

  const jqueryStub = selector => {
    if (selector === '#chat .ygg-floor') return {remove: () => {}};
    if (selector && typeof selector === 'object' && typeof selector.append === 'function') return selector;
    return createDomNode(selector);
  };

  const stubs = {
    $: jqueryStub,
    document: documentStub,
    SillyTavern: {
      POPUP_TYPE: {TEXT: 1},
      POPUP_RESULT: {AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null},
      getRequestHeaders: () => ({}),
      getContext: () => ({
        chatId,
        characters: [{
          avatar: 'playtest.png',
          data: {extensions: {tavern_helper: {scripts: []}, regex_scripts: []}},
        }],
        characterId: 0,
        is_send_press: false,
        extensionSettings: {character_allowed_regex: ['playtest.png']},
      }),
      callGenericPopup: async () => 1,
    },
    tavern_events: {
      GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
      MESSAGE_SENT: 'message_sent',
      MESSAGE_RECEIVED: 'message_received',
      MESSAGE_EDITED: 'message_edited',
      MESSAGE_SWIPED: 'message_swiped',
      MESSAGE_DELETED: 'message_deleted',
      CHAT_CHANGED: 'chat_id_changed',
      CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
      USER_MESSAGE_RENDERED: 'user_message_rendered',
    },
    getChatMessages: () => [],
    getLastMessageId: () => -1,
    getVariables: ({type} = {}) => (type === 'global' ? structuredClone(globals) : {}),
    replaceVariables: (variables, {type} = {}) => {
      if (type === 'global' && variables && typeof variables === 'object') {
        for (const key of Object.keys(globals)) delete globals[key];
        Object.assign(globals, structuredClone(variables));
      }
    },
    injectPrompts: prompts => {
      for (const prompt of Array.isArray(prompts) ? prompts : []) {
        if (prompt?.id) injected.set(prompt.id, prompt);
      }
    },
    uninjectPrompts: ids => {
      for (const id of Array.isArray(ids) ? ids : []) injected.delete(id);
    },
    retrieveDisplayedMessage: () => ({length: 0, after: () => {}}),
    eventOn: (type, fn) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    getButtonEvent: name => `button:${name}`,
    getModelList: async () => ['playtest-model'],
    getProxyPresetNames: () => ['None'],
    getCurrentChatId: () => chatId,
    toastr: Object.fromEntries(
      ['success', 'warning', 'error', 'info'].map(level => [
        level,
        (body, title = '') => {
          toasts.push({level, title: String(title ?? ''), body: String(body ?? '')});
        },
      ]),
    ),
    generateRaw: async config => {
      calls.push(structuredClone(config));
      if (responseQueue.length === 0) return '{}';
      const next = responseQueue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return await next(config);
      return next;
    },
  };

  const host = {
    pushResponse,
    clearResponses,
    calls,
    toasts,
    globals,
    findNode,
    findAllNodes,
  };

  return {stubs, host};
}

function locateEmbeddedScript(card) {
  const scripts = card?.data?.extensions?.tavern_helper?.scripts
    ?? card?.extensions?.tavern_helper?.scripts;
  if (!Array.isArray(scripts) || scripts.length === 0) {
    throw new Error('角色卡不含世界树内嵌脚本（缺少 data.extensions.tavern_helper.scripts）');
  }
  const preferred = scripts.find(
    item => item && typeof item === 'object' && item.name === '世界树' && typeof item.content === 'string' && item.content.trim(),
  );
  if (preferred) return preferred.content;
  const fallback = scripts.find(
    item => item && typeof item === 'object' && typeof item.content === 'string' && item.content.trim(),
  );
  if (fallback) return fallback.content;
  throw new Error('角色卡的 tavern_helper.scripts 中未找到非空内嵌脚本');
}

function detectLegacySymbols(source) {
  const found = [];
  for (const sym of LEGACY_SYMBOLS) {
    const directDecl = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?(?:var|let|const|function|class)\\s+${sym}\\b`, 'u');
    const commaDecl = new RegExp(`(?:^|\\n)(?:var|let|const)\\s+[^\\n;]*,\\s*${sym}\\s*=`, 'u');
    if (directDecl.test(source) || commaDecl.test(source)) {
      found.push(sym);
    }
  }
  return found;
}

async function importEsmSource(source) {
  const b64 = Buffer.from(source, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${b64}`);
}

/**
 * 只读挂载打包后的世界树角色卡 JSON，支持钩子模式（v0.1.3+）与旧包自动回退（v0.1.1/v0.1.2）。
 */
export async function mountCard(cardPath, options = {}) {
  if (typeof cardPath !== 'string' || !cardPath.trim()) {
    throw new Error('请提供角色卡 JSON 文件路径');
  }
  let rawBuffer;
  try {
    rawBuffer = await fs.readFile(cardPath);
  } catch (error) {
    throw new Error(`无法读取角色卡文件 ${path.basename(cardPath)}：${error.message}`);
  }
  let card;
  try {
    card = JSON.parse(rawBuffer.toString('utf8'));
  } catch (error) {
    throw new Error(`角色卡文件 ${path.basename(cardPath)} 不是合法 JSON：${error.message}`);
  }
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw new Error(`角色卡文件 ${path.basename(cardPath)} 顶层不是 JSON 对象`);
  }

  const esmText = locateEmbeddedScript(card);
  const {stubs, host} = createHostEnvironment(options);
  const trackedKeys = [...Object.keys(stubs), '__YGG_PLAYTEST_HOOK__'];
  const savedDescriptors = new Map();
  for (const key of trackedKeys) {
    savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const [key, desc] of savedDescriptors.entries()) {
      if (desc === undefined) {
        delete globalThis[key];
      } else {
        Object.defineProperty(globalThis, key, desc);
      }
    }
  };

  try {
    for (const [key, value] of Object.entries(stubs)) {
      Object.defineProperty(globalThis, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    let captured = null;
    Object.defineProperty(globalThis, '__YGG_PLAYTEST_HOOK__', {
      value: payload => {
        captured = payload;
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });

    const seq = ++mountCounter;
    const tag = `/* ygg-playtest-mount:${seq}:${Date.now()} */`;
    await importEsmSource(`${esmText}\n${tag}\n`);

    let api = null;
    let mode = 'hook';
    if (captured && typeof captured === 'object') {
      api = Object.isFrozen(captured) ? captured : Object.freeze({...captured});
    } else {
      mode = 'legacy-export';
      delete globalThis.__YGG_PLAYTEST_HOOK__;
      const symbols = detectLegacySymbols(esmText);
      if (symbols.length === 0) {
        throw new Error('内嵌脚本未触发 __YGG_PLAYTEST_HOOK__，且未检测到可回退导出的世界树符号');
      }
      const legacyTag = `/* ygg-playtest-legacy:${++mountCounter}:${Date.now()} */`;
      const exportLine = `\nexport { ${symbols.join(', ')} };\n${legacyTag}\n`;
      const ns = await importEsmSource(`${esmText}${exportLine}`);
      const assembled = {};
      for (const sym of symbols) {
        if (sym === 'bundle_generated_default') {
          if (!Object.hasOwn(assembled, 'bundle')) assembled.bundle = ns[sym];
        } else {
          assembled[sym] = ns[sym];
        }
      }
      if (!assembled.manifest && assembled.bundle?.manifest) {
        assembled.manifest = assembled.bundle.manifest;
      }
      if (!assembled.catalog && !assembled.bundle) {
        throw new Error('旧包回退导出失败：未找到 catalog 或 bundle 运行对象');
      }
      api = Object.freeze(assembled);
    }

    const cardMeta = {
      name: String(card.data?.name ?? card.name ?? ''),
      characterVersion: String(card.data?.character_version ?? card.character_version ?? ''),
      bytes: rawBuffer.byteLength,
      sha256: sha256Hex(rawBuffer),
      esmBytes: Buffer.byteLength(esmText, 'utf8'),
      esmSha256: sha256Hex(Buffer.from(esmText, 'utf8')),
      manifest: api.manifest ?? api.bundle?.manifest ?? null,
    };

    return {api, mode, cardMeta, host, cleanup};
  } catch (error) {
    cleanup();
    throw error;
  }
}

function isExcluded(relPosix, baseName, excludeRules) {
  for (const rule of excludeRules) {
    if (rule instanceof RegExp) {
      if (rule.test(relPosix) || rule.test(baseName)) return true;
    } else if (typeof rule === 'string' && rule) {
      const normalized = rule.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
      if (baseName === normalized || relPosix === normalized || relPosix.startsWith(`${normalized}/`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 确定性递归计算文件/目录 SHA-256（不跟随符号链接，仅输出规范化相对路径）。
 */
export async function snapshotHashes(targetDirOrFiles, {exclude = []} = {}) {
  const inputs = Array.isArray(targetDirOrFiles) ? targetDirOrFiles : [targetDirOrFiles];
  if (inputs.length === 0 || inputs.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('snapshotHashes 需要提供非空文件或目录路径');
  }
  const excludeRules = Array.isArray(exclude) ? exclude : [];
  const entries = [];
  const multiple = inputs.length > 1;

  async function walk(absPath, relPrefix) {
    const stat = await fs.lstat(absPath);
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(absPath);
      const rel = toPosix(relPrefix || path.basename(absPath));
      if (!isExcluded(rel, path.basename(absPath), excludeRules)) {
        entries.push([rel, sha256Hex(Buffer.from(`symlink:${target}`, 'utf8'))]);
      }
      return;
    }
    if (stat.isFile()) {
      const rel = toPosix(relPrefix || path.basename(absPath));
      if (!isExcluded(rel, path.basename(absPath), excludeRules)) {
        const content = await fs.readFile(absPath);
        entries.push([rel, sha256Hex(content)]);
      }
      return;
    }
    if (stat.isDirectory()) {
      const children = await fs.readdir(absPath);
      children.sort(compareCodePoints);
      for (const name of children) {
        const childRel = relPrefix ? `${relPrefix}/${name}` : name;
        if (isExcluded(toPosix(childRel), name, excludeRules)) continue;
        await walk(path.join(absPath, name), childRel);
      }
    }
  }

  for (let i = 0; i < inputs.length; i += 1) {
    const abs = path.resolve(inputs[i]);
    const stat = await fs.lstat(abs);
    const base = path.basename(abs);
    if (stat.isDirectory()) {
      await walk(abs, multiple ? base : '');
    } else {
      await walk(abs, base);
    }
  }

  entries.sort((left, right) => compareCodePoints(left[0], right[0]));
  const files = {};
  for (const [rel, hash] of entries) files[rel] = hash;
  const rootSha256 = sha256Hex(JSON.stringify(entries));
  return {fileCount: entries.length, rootSha256, files};
}

function evalConditionFallback(node, leaf, negative = false) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return true;
  const keys = Object.keys(node);
  if (keys.length !== 1) return true;
  const type = keys[0];
  const value = node[type];
  if (COMBINATORS.has(type)) {
    if (!Array.isArray(value) || value.length === 0) return true;
    const neg = type === 'none' ? !negative : negative;
    const mode = (type === 'all' && !negative) || (type === 'any' && negative) || (type === 'none' && !negative)
      ? 'all'
      : 'any';
    const values = value.map(child => evalConditionFallback(child, leaf, neg));
    if (mode === 'all') return values.includes(false) ? false : true;
    return values.includes(true) ? true : false;
  }
  return leaf(type, value, negative);
}

function evalThresholdBlocked(threshold, evaluateFn, leaf) {
  if (!threshold || typeof threshold !== 'object') return false;
  const result = evaluateFn(threshold, leaf);
  return result === false;
}

function conditionReferencesFallback(node, negative = false, conditionPath = '门槛') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const keys = Object.keys(node);
  if (keys.length !== 1) return [];
  const type = keys[0];
  const value = node[type];
  if (type === '事件确认' && value && typeof value === 'object' && !Array.isArray(value)) {
    return [{...value, 排斥: negative, 条件位置: conditionPath}];
  }
  if (!COMBINATORS.has(type) || !Array.isArray(value)) return [];
  const nextNeg = type === 'none' ? !negative : negative;
  return value.flatMap((child, index) => conditionReferencesFallback(
    child,
    nextNeg,
    `${conditionPath}.${type}[${index + 1}]`,
  ));
}

function computeEventTreeHealth(api, catalog, groups, events, chains) {
  const confirmStrategyCounts = {自动确认: 0, 条件确认: 0, 仅作候选: 0};
  const compoundNameSet = new Set();
  const refsFn = typeof api?.conditionReferences === 'function' ? api.conditionReferences : conditionReferencesFallback;

  const downstreamReferencedIds = new Set();
  const profileReferencedIds = new Set();
  const chainEndingIds = new Set();
  const openingOptionIds = new Set();

  for (const event of events) {
    const content = event?.内容 ?? {};
    const policy = content.确认策略;
    if (policy === '自动确认' || policy === '条件确认' || policy === '仅作候选') {
      confirmStrategyCounts[policy] += 1;
    } else if (policy !== undefined && policy !== null && policy !== '') {
      confirmStrategyCounts.其他 = (confirmStrategyCounts.其他 ?? 0) + 1;
    }

    if ((typeof event?.id === 'string' && COMPOUND_NAME_RE.test(event.id))
      || (typeof content.事件标题 === 'string' && COMPOUND_NAME_RE.test(content.事件标题))) {
      compoundNameSet.add(event.id);
    }

    for (const ref of refsFn(content.门槛)) {
      if (!ref?.排斥 && typeof ref?.事件ID === 'string' && ref.事件ID !== event.id) {
        downstreamReferencedIds.add(ref.事件ID);
      }
    }
    const branches = Array.isArray(content.分支) ? content.分支 : [];
    for (const branch of branches) {
      for (const ref of refsFn(branch?.门槛)) {
        if (!ref?.排斥 && typeof ref?.事件ID === 'string' && ref.事件ID !== event.id) {
          downstreamReferencedIds.add(ref.事件ID);
        }
      }
    }
  }

  for (const group of groups) {
    const declaredProfiles = Array.isArray(group?.内容?.档案) ? group.内容.档案 : [];
    for (const profile of declaredProfiles) {
      for (const ref of refsFn(profile?.生效条件)) {
        if (!ref?.排斥 && typeof ref?.事件ID === 'string') {
          profileReferencedIds.add(ref.事件ID);
        }
      }
    }
  }

  for (const chain of chains) {
    const endings = Array.isArray(chain?.内容?.结局) ? chain.内容.结局 : [];
    for (const ending of endings) {
      if (typeof ending?.事件ID === 'string') {
        chainEndingIds.add(ending.事件ID);
      }
    }
  }

  const openingOptions = Array.isArray(catalog?.openingOptions?.内容?.选项)
    ? catalog.openingOptions.内容.选项
    : [];
  for (const item of openingOptions) {
    if (typeof item?.事件ID === 'string') {
      openingOptionIds.add(item.事件ID);
    }
  }

  const zeroChangeLeafSet = new Set();
  for (const event of events) {
    const branches = Array.isArray(event?.内容?.分支) ? event.内容.分支 : [];
    const hasChange = branches.some(b => Array.isArray(b?.变化) && b.变化.length > 0);
    if (hasChange) continue;
    if (downstreamReferencedIds.has(event.id)) continue;
    if (profileReferencedIds.has(event.id)) continue;
    if (chainEndingIds.has(event.id) || openingOptionIds.has(event.id)) continue;
    zeroChangeLeafSet.add(event.id);
  }

  const compoundNameIds = [...compoundNameSet].sort(compareCodePoints);
  const zeroChangeLeafIds = [...zeroChangeLeafSet].sort(compareCodePoints);
  const autoConfirmRatio = events.length > 0
    ? Number((confirmStrategyCounts.自动确认 / events.length).toFixed(4))
    : 0;

  return {
    confirmStrategyCounts,
    autoConfirmRatio,
    compoundNameIds,
    zeroChangeLeafEvents: {
      count: zeroChangeLeafIds.length,
      ids: zeroChangeLeafIds,
    },
  };
}

/**
 * 基于挂载后的真实运行时对象，产出结构化基线探针结果（计数、D1 默认档案清单、D4 停用影响测算）。
 */
export function probeCard(api, {disableGroups = []} = {}) {
  const catalog = api?.catalog;
  if (!catalog || typeof catalog !== 'object') {
    throw new Error('probeCard 需要包含有效 catalog 的挂载运行对象');
  }

  const groups = Array.isArray(catalog.groups) ? catalog.groups : [];
  const events = Array.isArray(catalog.events) ? catalog.events : [];
  const chains = Array.isArray(catalog.chains) ? catalog.chains : [];
  const worldlines = Array.isArray(catalog.worldlines) ? catalog.worldlines : [];
  const openingPlans = Array.isArray(catalog.openingPlans) ? catalog.openingPlans : [];

  const entriesByLibrary = {};
  if (catalog.entries && typeof catalog.entries === 'object') {
    for (const libName of Object.keys(catalog.entries).sort(compareCodePoints)) {
      const list = catalog.entries[libName];
      entriesByLibrary[libName] = Array.isArray(list) ? list.length : 0;
    }
  }

  const counts = {
    groups: groups.length,
    profiles: groups.reduce((sum, group) => sum + (Array.isArray(group.档案) ? group.档案.length : 0), 0),
    events: events.length,
    chains: chains.length,
    worldlines: worldlines.length,
    openingPlans: openingPlans.length,
    entriesByLibrary,
  };

  const defaultProfiles = [];
  for (const group of groups) {
    const displayName = String(group.内容?.显示名 ?? group.id);
    const declaredProfiles = Array.isArray(group.内容?.档案) ? group.内容.档案 : [];
    const loadedById = new Map((Array.isArray(group.档案) ? group.档案 : []).map(item => [item.id, item]));
    const allVersions = Array.isArray(group.版本清单) && group.版本清单.length > 0 ? [...group.版本清单] : [group.id];

    for (const item of declaredProfiles) {
      if (!item || item.默认 !== true) continue;
      const profileId = String(item.档案ID ?? '');
      const loadedProfile = loadedById.get(profileId);
      const applicableVersions = Array.isArray(item.适用版本) && item.适用版本.length > 0
        ? [...item.适用版本]
        : [...allVersions];
      defaultProfiles.push({
        groupId: group.id,
        displayName,
        profileId,
        applicableVersions,
        hasBasicInfo: Boolean(loadedProfile?.基本信息 && typeof loadedProfile.基本信息 === 'object'),
        hasImpression: Boolean(loadedProfile?.角色印象 && typeof loadedProfile.角色印象 === 'object'),
      });
    }
  }

  const normalizedDisable = [...new Set(
    (Array.isArray(disableGroups) ? disableGroups : [])
      .filter(id => typeof id === 'string' && id.trim())
      .map(id => id.trim()),
  )];

  let disabledImpact = null;
  if (normalizedDisable.length > 0) {
    const disabledSet = new Set(normalizedDisable);
    const evaluateFn = typeof api.evaluateCondition === 'function' ? api.evaluateCondition : evalConditionFallback;
    const directIds = [];
    const directSet = new Set();

    for (const event of events) {
      const content = event.内容 ?? {};
      const coreParticipants = Array.isArray(content.核心参与者) ? content.核心参与者 : [];
      const coreHit = coreParticipants.some(id => disabledSet.has(id));
      const thresholdHit = !coreHit && evalThresholdBlocked(content.门槛, evaluateFn, (type, value, negative) => {
        if (negative || !GROUP_DEP_TYPES.has(type) || !value || typeof value !== 'object') return true;
        if (type === '同处') {
          return !(Array.isArray(value.角色组ID) && value.角色组ID.some(id => disabledSet.has(id)));
        }
        return !disabledSet.has(value.角色组ID);
      });
      if (coreHit || thresholdHit) {
        directIds.push(event.id);
        directSet.add(event.id);
      }
    }

    const cascadeIds = [];
    const blockedSet = new Set(directSet);
    let changed = true;
    while (changed) {
      changed = false;
      for (const event of events) {
        if (blockedSet.has(event.id)) continue;
        const threshold = event.内容?.门槛;
        if (!threshold) continue;
        const blocked = evalThresholdBlocked(threshold, evaluateFn, (type, value, negative) => {
          if (!negative && type === '事件确认' && value && typeof value === 'object' && blockedSet.has(value.事件ID)) {
            return false;
          }
          return true;
        });
        if (blocked) {
          blockedSet.add(event.id);
          cascadeIds.push(event.id);
          changed = true;
        }
      }
    }

    directIds.sort(compareCodePoints);
    cascadeIds.sort(compareCodePoints);

    disabledImpact = {
      disableGroups: normalizedDisable,
      totalEvents: events.length,
      directDisabled: directIds.length,
      cascadeDisabled: cascadeIds.length,
      survivingEvents: events.length - directIds.length - cascadeIds.length,
      directIds,
      cascadeIds,
    };
  }

  const eventTreeHealth = computeEventTreeHealth(api, catalog, groups, events, chains);

  return {counts, defaultProfiles, disabledImpact, eventTreeHealth};
}

function parseCliArgs(argv) {
  let cardPath = null;
  let probe = false;
  let json = false;
  let help = false;
  const disableGroups = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '--probe') {
      probe = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--disable-group') {
      if (i + 1 >= argv.length || !argv[i + 1] || argv[i + 1].startsWith('-')) {
        throw new Error('选项 --disable-group 缺少角色组 ID 参数');
      }
      disableGroups.push(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--disable-group=')) {
      const value = arg.slice('--disable-group='.length);
      if (!value) throw new Error('选项 --disable-group 缺少角色组 ID 参数');
      disableGroups.push(value);
    } else if (arg.startsWith('-')) {
      throw new Error(`未知选项：${arg}`);
    } else if (!cardPath) {
      cardPath = arg;
    } else {
      throw new Error(`多余的位置参数：${arg}`);
    }
  }

  return {cardPath, probe, json, help, disableGroups};
}

function formatProbeSummary(payload) {
  const {card, mode, cardMeta, probe} = payload;
  const {counts, defaultProfiles, disabledImpact, eventTreeHealth} = probe;
  const lines = [
    `角色卡：${cardMeta.name || card}（版本 ${cardMeta.characterVersion || '未写'}，文件 ${card}）`,
    `挂载模式：${mode} | 卡文件 ${cardMeta.bytes} B (${cardMeta.sha256.slice(0, 12)}…) | 内嵌脚本 ${cardMeta.esmBytes} B (${cardMeta.esmSha256.slice(0, 12)}…)`,
  ];
  if (cardMeta.manifest) {
    lines.push(
      `构建清单：卡ID ${cardMeta.manifest.卡ID ?? '未知'} | 世界书 ${String(cardMeta.manifest.世界书哈希 ?? '').slice(0, 12)}… | 程序 ${String(cardMeta.manifest.程序指纹 ?? '').slice(0, 12)}…`,
    );
  }
  const libText = Object.entries(counts.entriesByLibrary)
    .map(([name, count]) => `${name} ${count}`)
    .join('、') || '无';
  lines.push(
    `结构计数：${counts.groups} 角色组、${counts.profiles} 档案、${counts.events} 事件、${counts.chains} 事件串、${counts.worldlines} 世界线、${counts.openingPlans} 开局方案；条目库：${libText}`,
    `默认档案（D1 待审计）：${defaultProfiles.length} 份`,
  );
  if (eventTreeHealth) {
    const {confirmStrategyCounts: csc, autoConfirmRatio, compoundNameIds, zeroChangeLeafEvents} = eventTreeHealth;
    lines.push(
      `事件树健康：确认策略 自动确认 ${csc.自动确认}（${(autoConfirmRatio * 100).toFixed(1)}%）、条件确认 ${csc.条件确认}、仅作候选 ${csc.仅作候选}；疑似拼盘命名 ${compoundNameIds.length}；零变化孤立事件 ${zeroChangeLeafEvents.count}`,
    );
  }
  if (disabledImpact) {
    lines.push(
      `停用影响（D4，停用 [${disabledImpact.disableGroups.join('、')}]）：共 ${disabledImpact.totalEvents} 事件，直接停摆 ${disabledImpact.directDisabled}、级联停摆 ${disabledImpact.cascadeDisabled}、存活 ${disabledImpact.survivingEvents}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let mounted = null;
  try {
    const {cardPath, probe, json, help, disableGroups} = parseCliArgs(argv);
    if (help) {
      stdout.write(USAGE);
      return 0;
    }
    if (!cardPath) {
      stderr.write(`错误：请提供待挂载的角色卡 JSON 路径。\n\n${USAGE}`);
      return 1;
    }
    if (!probe) {
      stderr.write(`错误：CLI 模式请指定 --probe 执行只读探针。\n\n${USAGE}`);
      return 1;
    }
    mounted = await mountCard(cardPath);
    const probeResult = probeCard(mounted.api, {disableGroups});
    const payload = {
      card: path.basename(cardPath),
      mode: mounted.mode,
      cardMeta: {
        name: mounted.cardMeta.name,
        characterVersion: mounted.cardMeta.characterVersion,
        bytes: mounted.cardMeta.bytes,
        sha256: mounted.cardMeta.sha256,
        esmBytes: mounted.cardMeta.esmBytes,
        esmSha256: mounted.cardMeta.esmSha256,
        manifest: mounted.cardMeta.manifest
          ? {
              卡ID: mounted.cardMeta.manifest.卡ID ?? null,
              卡版本: mounted.cardMeta.manifest.卡版本 ?? null,
              程序版本: mounted.cardMeta.manifest.程序版本 ?? null,
              记录格式: mounted.cardMeta.manifest.记录格式 ?? null,
              世界书哈希: mounted.cardMeta.manifest.世界书哈希 ?? null,
              程序指纹: mounted.cardMeta.manifest.程序指纹 ?? null,
            }
          : null,
      },
      probe: probeResult,
    };
    if (json) {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      stdout.write(formatProbeSummary(payload));
    }
    return 0;
  } catch (error) {
    stderr.write(`挂载探针失败：${error.message}\n`);
    return 1;
  } finally {
    mounted?.cleanup();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
