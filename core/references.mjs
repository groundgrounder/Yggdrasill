import {CONDITION_COMBINATORS, CONDITION_TYPES, PROFILE_FIELDS} from './contract.mjs';
import {conditionReferences} from './conditions.mjs';
import {analyzeEventTree} from './graph.mjs';
import {codepointCompare, has, isMap, isText, issue, list, pairs} from './utils.mjs';

const OBJECT_TYPES = new Set(['事件', '事件串', '角色组', '档案', '条目', '剧情标记', '世界线', '开局选项', '开局方案']);
const QUERYABLE_TARGETS = new Set(OBJECT_TYPES);
const CONDITION_TYPES_SET = new Set(CONDITION_TYPES);

export function parseObjectKey(objectKey) {
  if (typeof objectKey !== 'string' || !objectKey.length) {
    return {ok: false, type: null, id: null, error: '对象键不能为空'};
  }
  const colon = objectKey.indexOf(':');
  if (colon < 1) return {ok: false, type: null, id: null, error: `对象键“${objectKey}”缺少类型前缀`};
  const type = objectKey.slice(0, colon), id = objectKey.slice(colon + 1);
  if (!OBJECT_TYPES.has(type)) return {ok: false, type, id, error: `未知对象类型“${type}”`};
  if (!id.length) return {ok: false, type, id, error: `对象键“${objectKey}”缺少完整 ID`};
  return {ok: true, type, id};
}

export function buildReferenceIndex(catalog = {}, decl = {}, options = {}) {
  const objects = [], byKey = new Map(), references = [], referenceSignatures = new Set();
  const anomalies = normalizeIssues(options.issues ?? []), analysis = analyzeEventTree(catalog, decl);
  addIssues(anomalies, analysis.issues);

  const eventKey = id => `事件:${id}`;
  const chainKey = id => `事件串:${id}`;
  const groupKey = id => `角色组:${id}`;
  const archiveKey = (groupID, id) => `档案:${groupID}:${id}`;
  const entryKey = (library, id) => `条目:${library}:${id}`;
  const markKey = id => `剧情标记:${id}`;
  const worldlineKey = id => `世界线:${id}`;
  const versionKey = (groupID, id) => `角色版本:${groupID}:${id}`;

  for (const event of list(catalog.events)) register({
    key: eventKey(event.id), type: '事件', id: event.id, file: event.文件, content: event.内容, source: event,
  });
  for (const chain of list(catalog.chains)) register({
    key: chainKey(chain.id), type: '事件串', id: chain.id, file: chain.文件, content: chain.内容, source: chain,
  });
  for (const group of list(catalog.groups)) {
    register({key: groupKey(group.id), type: '角色组', id: group.id, file: group.文件, content: group.内容, source: group});
    const registrations = new Map(list(group.内容?.档案).filter(isMap)
      .filter(item => isText(item.档案ID)).map(item => [item.档案ID, item]));
    for (const profile of list(group.档案)) register({
      key: archiveKey(group.id, profile.id), type: '档案', id: `${group.id}:${profile.id}`, file: group.文件,
      content: registrations.get(profile.id) ?? null, source: {...profile, group, registration: registrations.get(profile.id) ?? null},
    });
  }
  for (const [library, entries] of pairs(catalog.entries)) for (const entry of list(entries)) register({
    key: entryKey(library, entry.id), type: '条目', id: `${library}:${entry.id}`, file: entry.文件, content: entry.内容,
    source: {...entry, library},
  });
  for (const id of Object.keys(isMap(decl.marks) ? decl.marks : {})) register({
    key: markKey(id), type: '剧情标记', id, file: '设定/剧情标记.yaml', content: decl.marks[id], source: decl.marks[id],
  });
  for (const worldline of list(catalog.worldlines)) register({
    key: worldlineKey(worldline.id), type: '世界线', id: worldline.id, file: worldline.文件, content: worldline.内容, source: worldline,
  });

  if (catalog.openingOptions) list(catalog.openingOptions.内容?.选项).forEach((option, index) => register({
    key: `开局选项:${index + 1}`, type: '开局选项', id: String(index + 1), file: catalog.openingOptions.文件,
    content: isMap(option) ? option : null, source: option,
  }));
  for (const plan of list(catalog.openingPlans)) register({
    key: `开局方案:${plan.id}`, type: '开局方案', id: plan.id, file: plan.文件, content: plan.内容, source: plan,
  });

  objects.sort(compareObjects);
  for (const group of list(catalog.groups)) indexGroup(group);
  for (const event of list(catalog.events)) indexEvent(event);
  for (const chain of list(catalog.chains)) indexChain(chain);
  for (const [library, entries] of pairs(catalog.entries)) for (const entry of list(entries)) indexEntry(library, entry);
  indexOpenings();

  references.sort(compareReferences);
  const frozenReferences = Object.freeze(references.map(reference => Object.freeze({...reference})));
  const frozenObjects = Object.freeze(objects.map(object => Object.freeze(publicObject(object))));
  const frozenIssues = Object.freeze(anomalies.map(anomaly => Object.freeze({...anomaly})));

  const index = {
    objects: frozenObjects,
    references: frozenReferences,
    issues: frozenIssues,
    query: objectKey => queryReference(objectKey),
  };
  return Object.freeze(index);

  function register(object) {
    const value = {...object};
    objects.push(value);
    if (!byKey.has(value.key)) byKey.set(value.key, []);
    byKey.get(value.key).push(value);
  }

  function publicObject(object) {
    return {对象键: object.key, 类型: object.type, ID: object.id, 定义文件: object.file ?? null};
  }

  function keyObject(key) { return byKey.get(key)?.length === 1 ? byKey.get(key)[0] : null; }

  function targetFile(type, id, options = {}) {
    const key = type === '事件' ? eventKey(id)
      : type === '事件串' ? chainKey(id)
        : type === '角色组' ? groupKey(id)
          : type === '档案' ? archiveKey(options.groupID, id)
            : type === '条目' ? entryKey(options.library, id)
              : type === '剧情标记' ? markKey(id)
                : type === '世界线' ? worldlineKey(id)
                  : type === '角色版本' ? versionKey(options.groupID, id) : null;
    return {key, file: key ? keyObject(key)?.file ?? options.file ?? null : options.file ?? null};
  }

  function addReference({source, sourceKey, sourceType, sourceFile, field, kind, polarity = null,
    targetKey, targetType, targetFile: file = null}) {
    if (!isText(sourceKey) || !isText(sourceType) || !isText(sourceFile)
      || !isText(targetKey) || !isText(targetType) || !isText(field) || !isText(kind)) return;
    const signature = JSON.stringify([sourceKey, sourceFile, targetKey, file, field, kind, polarity]);
    if (referenceSignatures.has(signature)) return;
    referenceSignatures.add(signature);
    references.push({来源对象: sourceKey, 来源类型: sourceType, 来源文件: sourceFile,
      目标对象: targetKey, 目标类型: targetType, 目标文件: file, 字段: field, 引用种类: kind, 极性: polarity});
    if (QUERYABLE_TARGETS.has(targetType) && !byKey.has(targetKey) && targetKey !== groupKey('玩家')) {
      addIssue(anomalies, issue('引用.目标不存在', '错误', sourceFile, `${field}：目标对象“${targetKey}”不存在`));
    }
  }

  function addTarget({sourceKey, sourceType, sourceFile, field, kind, polarity = null, type, id,
    groupID, library, file}) {
    if (!isText(id)) {
      addIssue(anomalies, issue('引用.结构', '错误', sourceFile, `${field}：引用目标 ID 缺失或不是文本`));
      return;
    }
    const target = targetFile(type, id, {groupID, library, file});
    if (!target.key) return;
    addReference({sourceKey, sourceType, sourceFile, field, kind, polarity,
      targetKey: target.key, targetType: type, targetFile: target.file});
  }

  function addNamespaceTarget({sourceKey, sourceType, sourceFile, field, kind, polarity = null, namespace, id}) {
    const type = namespace === '角色组' ? '角色组' : namespace === '事件' ? '事件' : '条目';
    addTarget({sourceKey, sourceType, sourceFile, field, kind, polarity, type, id,
      library: namespace === '角色组' || namespace === '事件' ? undefined : namespace});
  }

  function addEventConditionReferences({condition, sourceKey, sourceType, sourceFile, path}) {
    for (const reference of conditionReferences(condition, false, path)) {
      addTarget({sourceKey, sourceType, sourceFile, field: reference.条件位置, kind: '事件确认',
        polarity: reference.排斥 ? '排斥' : '正向', type: '事件', id: reference.事件ID});
    }
    collectNonEventConditionReferences({condition, sourceKey, sourceType, sourceFile, path});
  }

  function collectNonEventConditionReferences({condition, sourceKey, sourceType, sourceFile, path}) {
    walk(condition, path, false);

    function walk(node, field, negative) {
      if (!isMap(node) || Object.keys(node).length !== 1) {
        addIssue(anomalies, issue('引用.条件结构', '错误', sourceFile, `${field}：条件须为只有一个类型键的映射`));
        return;
      }
      const [[type, value]] = Object.entries(node);
      if (CONDITION_COMBINATORS.includes(type)) {
        if (!Array.isArray(value) || !value.length) {
          addIssue(anomalies, issue('引用.条件结构', '错误', sourceFile, `${field}：${type} 须为非空列表`));
          return;
        }
        value.forEach((child, index) => walk(child, `${field}.${type}[${index + 1}]`, type === 'none' ? !negative : negative));
        return;
      }
      if (!CONDITION_TYPES_SET.has(type)) {
        addIssue(anomalies, issue('引用.条件结构', '错误', sourceFile, `${field}：未知条件类型“${type}”`));
        return;
      }
      if (type === '事件确认') return;
      const polarity = negative ? '排斥' : '正向';
      if (type === '角色启用' || type === '角色已出场' || type === '角色版本' || type === '角色状态')
        addTarget({sourceKey, sourceType, sourceFile, field, kind: type, polarity, type: '角色组', id: value?.角色组ID});
      if (type === '角色版本')
        addTarget({sourceKey, sourceType, sourceFile, field, kind: '角色版本.版本', polarity, type: '角色版本',
          id: value?.版本ID, groupID: value?.角色组ID});
      if (type === '事件串状态')
        addTarget({sourceKey, sourceType, sourceFile, field, kind: type, polarity, type: '事件串', id: value?.事件串ID});
      if (type === '剧情标记')
        addTarget({sourceKey, sourceType, sourceFile, field, kind: type, polarity, type: '剧情标记', id: value?.标记ID});
      if (type === '同处') for (const id of list(value?.角色组ID))
        addTarget({sourceKey, sourceType, sourceFile, field, kind: '同处.角色组', polarity, type: '角色组', id});
      if (type === '当前场景')
        addTarget({sourceKey, sourceType, sourceFile, field, kind: '当前场景.地标', polarity, type: '条目',
          id: value?.地标, library: '地点'});
      if (type === '在场实力人数') for (const id of list(value?.排除角色组))
        addTarget({sourceKey, sourceType, sourceFile, field, kind: '在场实力人数.排除角色组', polarity, type: '角色组', id});
      if (type === '世界线')
        addTarget({sourceKey, sourceType, sourceFile, field, kind: type, polarity, type: '世界线', id: value?.世界线ID});
      if (type === '角色状态') collectRoleStateReferences({value, sourceKey, sourceType, sourceFile, field, polarity});
    }
  }

  function collectRoleStateReferences({value, sourceKey, sourceType, sourceFile, field, polarity}) {
    if (!isText(value?.字段)) return;
    if (value.字段 === '所在') {
      for (const id of list(value.属于)) addTarget({sourceKey, sourceType, sourceFile, field, kind: '角色状态.所在',
        polarity, type: '条目', id, library: '地点'});
      return;
    }
    const segments = value.字段.split('.');
    let schema = decl.variables?.角色?.[segments[0]];
    for (const segment of segments.slice(1)) {
      if (isMap(schema?.映射)) {
        if (isMap(schema.映射.键) && schema.映射.键.引用)
          addNamespaceTarget({sourceKey, sourceType, sourceFile, field, kind: '角色状态.映射键', polarity,
            namespace: schema.映射.键.引用, id: segment});
        schema = schema.映射.值;
      } else schema = schema?.子字段?.[segment];
    }
  }

  function indexGroup(group) {
    const sourceKey = groupKey(group.id), sourceType = '角色组', sourceFile = group.文件;
    const versions = list(group.内容?.版本), explicit = versions.length > 0;
    const versionIDs = explicit ? versions.map(item => item?.版本ID).filter(isText) : [group.id];
    versionIDs.forEach((id, index) => addTarget({
      sourceKey, sourceType, sourceFile, field: explicit ? `版本[${index + 1}].版本ID` : '角色组.ID',
      kind: explicit ? '角色组版本' : '隐含角色版本', type: '角色版本', id, groupID: group.id, file: group.文件,
    }));
    if (isText(group.内容?.默认版本)) addTarget({
      sourceKey, sourceType, sourceFile, field: '默认版本', kind: '默认版本', type: '角色版本', id: group.内容.默认版本,
      groupID: group.id, file: group.文件,
    });
    if (isText(group.内容?.初始所在)) addTarget({
      sourceKey, sourceType, sourceFile, field: '初始所在', kind: '初始所在', type: '条目',
      id: group.内容.初始所在, library: '地点',
    });
    list(group.内容?.档案).forEach((item, index) => {
      if (!isText(item?.档案ID)) return;
      addTarget({sourceKey, sourceType, sourceFile, field: `档案[${index + 1}].档案ID`, kind: '档案登记',
        type: '档案', id: item.档案ID, groupID: group.id});
    });
    for (const profile of list(group.档案)) indexArchive(group, profile);
  }

  function indexArchive(group, profile) {
    const sourceKey = archiveKey(group.id, profile.id), sourceType = '档案', sourceFile = group.文件;
    const registration = list(group.内容?.档案).filter(isMap).find(item => item.档案ID === profile.id) ?? null;
    const versions = list(registration?.适用版本).length ? list(registration.适用版本) : group.版本清单;
    versions.forEach((id, index) => addTarget({sourceKey, sourceType, sourceFile,
      field: list(registration?.适用版本).length ? `适用版本[${index + 1}]` : '角色组版本（隐含）', kind: '适用版本',
      type: '角色版本', id, groupID: group.id, file: group.文件,
    }));
    if (isText(registration?.前置档案)) addTarget({sourceKey, sourceType, sourceFile, field: '前置档案', kind: '前置档案',
      type: '档案', id: registration.前置档案, groupID: group.id});
    if (registration?.生效条件) addEventConditionReferences({condition: registration.生效条件, sourceKey, sourceType,
      sourceFile, path: '生效条件'});
    for (const [dimensionName, initial] of pairs(registration?.初始能力)) {
      const dimension = decl.ability?.维度?.[dimensionName];
      if (dimension?.类型 !== '集合' || !isMap(dimension.成员) || !isText(dimension.成员.条目库)) continue;
      list(initial).forEach((id, index) => addTarget({sourceKey, sourceType, sourceFile,
        field: `初始能力.${dimensionName}[${index + 1}]`, kind: '初始能力成员', type: '条目', id,
        library: dimension.成员.条目库,
      }));
    }
    list(registration?.初始装备).forEach((item, index) => {
      if (!isText(item?.装备ID)) return;
      addTarget({sourceKey, sourceType, sourceFile, field: `初始装备[${index + 1}].装备ID`, kind: '初始装备',
        type: '条目', id: item.装备ID, library: '装备',
      });
    });
    for (const kind of ['基本信息', '角色印象']) {
      const bodyFile = `${profile.目录}/${kind}.txt`;
      const extra = decl.textRules?.档案追加字段?.[kind] ?? {};
      const schemas = {...(PROFILE_FIELDS[kind] ?? {}), ...extra};
      const value = profile[kind];
      for (const [field, schema] of pairs(schemas)) if (has(value, field))
        collectSchemaReferences({value: value[field], schema, sourceKey, sourceType, sourceFile: bodyFile,
          path: `${kind}.${field}`, kind: '档案声明引用'});
      if (kind !== '基本信息') continue;
      for (const [index, item] of list(value?.能力特征?.技能补充).entries()) {
        if (!isText(item?.技能ID)) continue;
        addTarget({sourceKey, sourceType, sourceFile: bodyFile,
          field: `基本信息.能力特征.技能补充[${index + 1}].技能ID`, kind: '技能补充', type: '条目',
          id: item.技能ID, library: '技能',
        });
      }
    }
  }

  function indexEvent(event) {
    const sourceKey = eventKey(event.id), sourceType = '事件', sourceFile = event.文件, content = event.内容;
    for (const reference of analysis.references.get(event.id) ?? []) addTarget({
      sourceKey, sourceType, sourceFile, field: reference.条件位置, kind: '事件确认',
      polarity: reference.排斥 ? '排斥' : '正向', type: '事件', id: reference.事件ID,
    });
    if (content?.门槛) collectNonEventConditionReferences({condition: content.门槛, sourceKey, sourceType, sourceFile, path: '门槛'});
    list(content?.分支).forEach((branch, branchIndex) => {
      if (branch?.门槛) collectNonEventConditionReferences({condition: branch.门槛, sourceKey, sourceType, sourceFile,
        path: `分支.${branch.分支ID ?? branchIndex + 1}.门槛`});
    });
    list(content?.核心参与者).forEach((id, index) => addTarget({
      sourceKey, sourceType, sourceFile, field: `核心参与者[${index + 1}]`, kind: '核心参与者', type: '角色组', id,
    }));
    list(event.角色位置).forEach(position => {
      const id = isText(position.内容?.角色组ID) ? position.内容.角色组ID : position.角色组ID;
      addTarget({sourceKey, sourceType, sourceFile: position.文件, field: '角色位置.角色组ID', kind: '角色位置',
        type: '角色组', id,
      });
    });
    list(content?.地点).forEach((id, index) => addTarget({
      sourceKey, sourceType, sourceFile, field: `地点[${index + 1}]`, kind: '地点', type: '条目', id, library: '地点',
    }));
    list(content?.关联事件).forEach((id, index) => addTarget({
      sourceKey, sourceType, sourceFile, field: `关联事件[${index + 1}]`, kind: '关联事件', type: '事件', id,
    }));
    list(content?.分支).forEach((branch, branchIndex) => list(branch?.变化).forEach((change, changeIndex) =>
      indexChange({event, branch, branchIndex, change, changeIndex, sourceKey, sourceType, sourceFile})));
  }

  function indexChange({branch, branchIndex, change, changeIndex, sourceKey, sourceType, sourceFile}) {
    if (!isMap(change) || !isText(change.路径)) return;
    const field = `分支.${branch?.分支ID ?? branchIndex + 1}.变化[${changeIndex + 1}]`;
    const parts = change.路径.split('.');
    if (parts[0] === '角色' && isText(parts[1])) {
      addTarget({sourceKey, sourceType, sourceFile, field: `${field}.路径`, kind: '变化.角色组路径',
        type: '角色组', id: parts[1],
      });
      if (parts[2] === '所在') {
        if (has(change, '值')) addTarget({sourceKey, sourceType, sourceFile, field: `${field}.值`, kind: '变化.地点',
          type: '条目', id: change.值, library: '地点',
        });
      }
      else if (parts[2] === '装备' && isText(parts[3])) addTarget({sourceKey, sourceType, sourceFile,
        field: `${field}.路径`, kind: '变化.装备', type: '条目', id: parts[3], library: '装备',
      });
      else {
        let schema = decl.ability?.维度?.[parts[2]] ?? decl.variables?.角色?.[parts[2]];
        for (const segment of parts.slice(3)) {
          if (isMap(schema?.映射)) {
            if (isMap(schema.映射.键) && schema.映射.键.引用) addNamespaceTarget({
              sourceKey, sourceType, sourceFile, field: `${field}.路径`, kind: '变化.映射键',
              namespace: schema.映射.键.引用, id: segment,
            });
            schema = schema.映射.值;
          } else schema = schema?.子字段?.[segment];
        }
        indexChangeValue({change, schema, field, sourceKey, sourceType, sourceFile});
      }
      return;
    }
    if (parts[0] === '世界' && parts[1] === '剧情标记' && isText(parts[2])) {
      addTarget({sourceKey, sourceType, sourceFile, field: `${field}.路径`, kind: '变化.剧情标记',
        type: '剧情标记', id: parts[2],
      });
      return;
    }
    if (parts[0] === '世界' && isText(parts[1])) {
      let schema = decl.variables?.世界?.[parts[1]];
      for (const segment of parts.slice(2)) {
        if (isMap(schema?.映射)) {
          if (isMap(schema.映射.键) && schema.映射.键.引用) addNamespaceTarget({
            sourceKey, sourceType, sourceFile, field: `${field}.路径`, kind: '变化.映射键',
            namespace: schema.映射.键.引用, id: segment,
          });
          schema = schema.映射.值;
        } else schema = schema?.子字段?.[segment];
      }
      indexChangeValue({change, schema, field, sourceKey, sourceType, sourceFile});
    }
  }

  // 变化表里集合的“新增/移除”值是单个成员而非数组；普通列表引用仍按数组展开。
  function indexChangeValue({change, schema, field, sourceKey, sourceType, sourceFile}) {
    if (!has(change, '值')) return;
    const path = `${field}.值`;
    if (schema?.类型 === '集合' && isMap(schema.成员) && isText(schema.成员.条目库)) {
      addTarget({sourceKey, sourceType, sourceFile, field: path, kind: '变化.声明引用',
        type: '条目', id: change.值, library: schema.成员.条目库});
      return;
    }
    if (isMap(schema?.集合)) {
      collectSchemaReferences({value: change.值, schema: schema.集合, sourceKey, sourceType, sourceFile,
        path, kind: '变化.声明引用'});
      return;
    }
    collectSchemaReferences({value: change.值, schema, sourceKey, sourceType, sourceFile, path, kind: '变化.声明引用'});
  }

  function collectSchemaReferences({value, schema, sourceKey, sourceType, sourceFile, path, kind}) {
    if (!isMap(schema)) return;
    if (schema.引用) {
      for (const [index, id] of (schema.列表 ? list(value) : [value]).entries()) addNamespaceTarget({
        sourceKey, sourceType, sourceFile, field: schema.列表 ? `${path}[${index + 1}]` : path,
        kind, namespace: schema.引用, id,
      });
    }
    if (isMap(schema.子字段)) for (const [field, child] of pairs(schema.子字段)) if (has(value, field))
      collectSchemaReferences({value: value[field], schema: child, sourceKey, sourceType, sourceFile,
        path: `${path}.${field}`, kind});
    if (isMap(schema.映射) && isMap(value)) for (const [key, item] of pairs(value)) {
      collectSchemaReferences({value: key, schema: schema.映射.键, sourceKey, sourceType, sourceFile,
        path: `${path}.${key}.映射键`, kind});
      collectSchemaReferences({value: item, schema: schema.映射.值, sourceKey, sourceType, sourceFile,
        path: `${path}.${key}`, kind});
    }
    if (schema.集合) list(value).forEach((item, index) => collectSchemaReferences({
      value: item, schema: schema.集合, sourceKey, sourceType, sourceFile, path: `${path}[${index + 1}]`, kind,
    }));
    if (schema.类型 === '集合' && isMap(schema.成员) && isText(schema.成员.条目库)) for (const [index, id] of list(value).entries())
      addTarget({sourceKey, sourceType, sourceFile, field: `${path}[${index + 1}]`, kind,
        type: '条目', id, library: schema.成员.条目库,
      });
  }

  function indexChain(chain) {
    const sourceKey = chainKey(chain.id), sourceType = '事件串', sourceFile = chain.文件;
    list(chain.内容?.事件).forEach((id, index) => addTarget({
      sourceKey, sourceType, sourceFile, field: `事件[${index + 1}]`, kind: '事件串成员', type: '事件', id,
    }));
    list(chain.内容?.结局).forEach((ending, index) => addTarget({
      sourceKey, sourceType, sourceFile, field: `结局[${index + 1}].事件ID`, kind: '事件串结局', type: '事件',
      id: ending?.事件ID,
    }));
  }

  function indexEntry(library, entry) {
    const sourceKey = entryKey(library, entry.id), sourceType = '条目', sourceFile = entry.文件;
    if (isText(entry.上级)) addTarget({sourceKey, sourceType, sourceFile, field: '上级', kind: '条目上级',
      type: '条目', id: entry.上级, library,
    });
    for (const [field, schema] of pairs(decl.libraries?.[library]?.字段)) if (has(entry.内容, field))
      collectSchemaReferences({value: entry.内容[field], schema, sourceKey, sourceType, sourceFile,
        path: field, kind: '条目声明引用'});
  }

  function indexOpenings() {
    for (const worldline of list(catalog.worldlines)) {
      const sourceKey = worldlineKey(worldline.id), sourceType = '世界线', sourceFile = worldline.文件;
      for (const [groupID, choice] of pairs(worldline.内容?.角色组)) {
        addTarget({sourceKey, sourceType, sourceFile, field: `角色组.${groupID}`, kind: '世界线角色组', type: '角色组', id: groupID});
        if (isText(choice?.版本ID)) addTarget({sourceKey, sourceType, sourceFile,
          field: `角色组.${groupID}.版本ID`, kind: '世界线版本', type: '角色版本', id: choice.版本ID,
          groupID, file: `角色/${groupID}/角色组.yaml`,
        });
      }
    }
    if (catalog.openingOptions) for (const [index, option] of list(catalog.openingOptions.内容?.选项).entries()) {
      if (!isText(option?.事件ID)) continue;
      addTarget({sourceKey: `开局选项:${index + 1}`, sourceType: '开局选项', sourceFile: catalog.openingOptions.文件,
        field: `选项[${index + 1}].事件ID`, kind: '开局选项', type: '事件', id: option.事件ID,
      });
    }
    for (const plan of list(catalog.openingPlans)) {
      const sourceKey = `开局方案:${plan.id}`, sourceType = '开局方案', sourceFile = plan.文件;
      if (isText(plan.内容?.世界线)) addTarget({
        sourceKey, sourceType, sourceFile, field: '世界线', kind: '开局世界线', type: '世界线', id: plan.内容.世界线,
      });
      if (isText(plan.内容?.开局地点)) addTarget({
        sourceKey, sourceType, sourceFile, field: '开局地点', kind: '开局地点', type: '条目',
        id: plan.内容.开局地点, library: '地点',
      });
      for (const eventID of Object.keys(isMap(plan.内容?.历史选择) ? plan.内容.历史选择 : {})) addTarget({
        sourceKey, sourceType, sourceFile, field: `历史选择.${eventID}`, kind: '历史选择', type: '事件', id: eventID,
      });
      if (isText(plan.内容?.玩家?.扮演角色组)) addTarget({
        sourceKey, sourceType, sourceFile, field: '玩家.扮演角色组', kind: '开局扮演角色组', type: '角色组',
        id: plan.内容.玩家.扮演角色组,
      });
      for (const [groupID, choice] of pairs(plan.内容?.角色组)) {
        addTarget({sourceKey, sourceType, sourceFile, field: `角色组.${groupID}`, kind: '开局角色组', type: '角色组', id: groupID});
        if (isText(choice?.版本ID)) addTarget({sourceKey, sourceType, sourceFile,
          field: `角色组.${groupID}.版本ID`, kind: '开局版本', type: '角色版本', id: choice.版本ID,
          groupID, file: `角色/${groupID}/角色组.yaml`,
        });
      }
    }
  }

  function queryReference(objectKey) {
    const parsed = parseObjectKey(objectKey);
    if (!parsed.ok) return failure(parsed, objectKey, parsed.error);
    const matches = byKey.get(objectKey) ?? [];
    if (!matches.length) return failure(parsed, objectKey, `对象“${objectKey}”不存在`);
    if (matches.length > 1) {
      const files = matches.map(item => item.file ?? '（缺定义文件）').sort(codepointCompare).join('、');
      return failure(parsed, objectKey, `对象“${objectKey}”有 ${matches.length} 个同键定义：${files}`);
    }
    const object = matches[0];
    const localAnomalies = [];
    const sources = sourceRecords(object, localAnomalies);
    return {
      对象: publicObject(object),
      引用它: frozenReferences.filter(reference => reference.目标对象 === object.key).map(incomingReference),
      它引用: frozenReferences.filter(reference => reference.来源对象 === object.key).map(outgoingReference),
      出处: sources,
      异常: normalizeIssues([...anomalies, ...localAnomalies]),
    };
  }

  function failure(parsed, objectKey, message) {
    const rule = message.startsWith('未知对象类型') ? 'trace.未知类型'
      : message.includes('同键定义') ? 'trace.歧义'
        : /缺少|不能为空/.test(message) ? 'trace.参数' : 'trace.对象不存在';
    return {
      对象: {对象键: objectKey, 类型: parsed.type ?? null, ID: parsed.id ?? null, 定义文件: null},
      引用它: [],
      它引用: [],
      出处: [],
      异常: normalizeIssues([...anomalies, issue(rule, '错误', 'trace', message)]),
    };
  }

  function sourceRecords(object, localAnomalies) {
    const records = list(catalog.sources?.记录);
    const selected = [];
    if (object.type === '事件') {
      for (const record of records) if (isMap(record.内容) && record.内容.事件ID === object.id) {
        selected.push(publicSource(record));
        if (!isText(record.内容.来源)) addIssue(localAnomalies,
          issue('出处.结构', '错误', record.文件, `第 ${record.序号} 条出处缺少来源文本`));
        if (has(record.内容, '角色组ID') || has(record.内容, '台词')) {
          if (!isText(record.内容.角色组ID) || !isText(record.内容.台词)) addIssue(localAnomalies,
            issue('出处.结构', '错误', record.文件, `第 ${record.序号} 条台词记录缺少角色组ID或台词`));
          const positions = list(object.source?.角色位置);
          if (!positions.some(position => (position.内容?.角色组ID ?? position.角色组ID) === record.内容.角色组ID))
            addIssue(localAnomalies, issue('出处.角色位置不符', '错误', record.文件,
              `第 ${record.序号} 条台词记录未对应本事件的实际角色位置`));
        }
      }
    }
    if (object.type === '角色组') {
      const events = new Map(list(catalog.events).map(event => [event.id, event]));
      for (const record of records) if (isMap(record.内容) && record.内容.角色组ID === object.id) {
        const event = events.get(record.内容.事件ID);
        const positions = list(event?.角色位置);
        const isPosition = positions.some(position => (position.内容?.角色组ID ?? position.角色组ID) === object.id);
        if (!event || !isPosition) {
          addIssue(localAnomalies, issue('出处.角色位置不符', '错误', record.文件,
            `第 ${record.序号} 条台词记录未对应事件“${String(record.内容.事件ID)}”的实际角色位置`));
          continue;
        }
        if (!isText(record.内容.来源)) addIssue(localAnomalies,
          issue('出处.结构', '错误', record.文件, `第 ${record.序号} 条出处缺少来源文本`));
        if (!isText(record.内容.台词)) addIssue(localAnomalies,
          issue('出处.结构', '错误', record.文件, `第 ${record.序号} 条台词记录缺少台词`));
        selected.push(publicSource(record));
      }
    }
    return selected.sort(compareSources);
  }
}

export function queryReference(index, objectKey) {
  if (!index || typeof index.query !== 'function') throw new TypeError('queryReference 需要 buildReferenceIndex 的返回值');
  return index.query(objectKey);
}

export function traceCatalog(catalog, decl = {}, objectKey, options = {}) {
  return buildReferenceIndex(catalog, decl, options).query(objectKey);
}

export function isTraceFailure(result) {
  return list(result?.异常).some(item => item?.级别 === '错误');
}

function incomingReference(reference) {
  return {来源对象: reference.来源对象, 来源类型: reference.来源类型, 来源文件: reference.来源文件,
    字段: reference.字段, 引用种类: reference.引用种类, 极性: reference.极性};
}

function outgoingReference(reference) {
  return {目标对象: reference.目标对象, 目标类型: reference.目标类型, 目标文件: reference.目标文件,
    字段: reference.字段, 引用种类: reference.引用种类, 极性: reference.极性};
}

function publicSource(record) {
  const content = isMap(record.内容) ? record.内容 : {};
  const speech = has(content, '角色组ID') || has(content, '台词');
  return {来源文件: record.文件, 记录序号: record.序号, 记录类型: speech ? '台词' : '事件',
    来源文本: isText(content.来源) ? content.来源 : null, 事件ID: isText(content.事件ID) ? content.事件ID : null,
    角色组ID: isText(content.角色组ID) ? content.角色组ID : null, 台词: isText(content.台词) ? content.台词 : null};
}

function normalizeIssues(values) {
  const map = new Map();
  for (const value of list(values)) {
    if (!isMap(value)) continue;
    const current = {规则: String(value.规则 ?? '未知'), 级别: String(value.级别 ?? '错误'),
      文件: String(value.文件 ?? ''), 说明: String(value.说明 ?? '')};
    map.set(JSON.stringify(current), current);
  }
  return [...map.values()].sort(compareIssues);
}

function addIssues(target, values) {
  const merged = normalizeIssues([...target, ...list(values)]);
  target.splice(0, target.length, ...merged);
}

function addIssue(target, value) {
  const current = normalizeIssues([...target, value]);
  target.splice(0, target.length, ...current);
}

function compareObjects(left, right) {
  return codepointCompare(left.key, right.key) || codepointCompare(left.file ?? '', right.file ?? '')
    || codepointCompare(left.type, right.type) || codepointCompare(left.id, right.id);
}

function compareReferences(left, right) {
  return codepointCompare(left.来源对象, right.来源对象) || codepointCompare(left.来源文件, right.来源文件)
    || codepointCompare(left.字段, right.字段) || codepointCompare(left.引用种类, right.引用种类)
    || codepointCompare(left.极性 ?? '', right.极性 ?? '') || codepointCompare(left.目标对象, right.目标对象)
    || codepointCompare(left.目标文件 ?? '', right.目标文件 ?? '');
}

function compareSources(left, right) {
  return codepointCompare(left.来源文件, right.来源文件) || left.记录序号 - right.记录序号
    || codepointCompare(left.事件ID ?? '', right.事件ID ?? '') || codepointCompare(left.角色组ID ?? '', right.角色组ID ?? '');
}

function compareIssues(left, right) {
  return codepointCompare(left.文件, right.文件) || codepointCompare(left.规则, right.规则)
    || codepointCompare(left.级别, right.级别) || codepointCompare(left.说明, right.说明);
}
