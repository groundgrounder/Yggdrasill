// 世界树核心契约：任何采用本架构的世界书都成立的字段、取值与保留字。作品取值见方言（dialect.mjs）。
// 规范正文见 docs/参考/（协议、事件、角色、世界书）与 docs/写作规范.md，索引见 docs/README.md；本文件是其中机器可判断部分的唯一出处。
const freeze = o => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(freeze); } return o; };

export const SPEC_VERSION = '0.1';

// 保留字：自建玩家的角色组ID、首次登场初始化事件的前缀与分支、动态事件默认分支。
export const PLAYER = '玩家';
export const DEBUT_PREFIX = '初次登场·';
export const DEBUT_BRANCH = '初始化';
export const DYNAMIC_BRANCH = '完成';

// 机器字段：路由在注入模型前剥离。
export const MACHINE_FIELDS = freeze(['门槛', '确认策略', '默认分支', '变化', '前置档案', '生效条件', '默认', '适用分支', '适用版本', '关联事件']);

export const CONFIRMATION_POLICIES = freeze(['自动确认', '条件确认', '仅作候选']);
export const CHANGE_OPERATIONS = freeze(['设定', '增加', '减少', '新增', '移除']);
export const COMBINATORS = freeze(['all', 'any', 'none']);
export const INITIALIZATION_MODES = freeze(['显式确认', '出场自动']);
export const PLAYER_MODES = freeze(['扮演', '自建']);

// 条件类型及参数。sealable=false 的条件在封卷时没有场景与在场者，求值为未知。
export const CONDITION_TYPES = freeze({
  角色启用: {参数: ['角色组ID'], sealable: true},
  角色版本: {参数: ['角色组ID', '版本ID'], sealable: true},
  事件确认: {参数: ['事件ID', '分支ID'], sealable: true},
  当前时间: {参数: ['比较', '值'], 比较: ['小于', '大于等于'], sealable: true},
  剧情标记: {参数: ['标记ID', '比较', '值'], 比较: ['等于', '不等于'], sealable: true},
  当前场景: {参数: ['地标', '场景'], sealable: false},
  在场实力人数: {参数: ['最低实力', '最少人数', '排除角色组'], sealable: false},
  角色已出场: {参数: ['角色组ID'], sealable: true},
});

export const EVENT = freeze({
  required: ['事件ID', '事件标题', '事件概要', '主类型', '标签', '事件结果', '影响范围', '时间范围', '确认策略', '核心参与者', '默认分支', '分支'],
  optional: ['地点或范围', '门槛', '关联事件', '叙事条件', '公开信息', '隐秘信息', '来源摘要'],
  branch: ['分支ID', '分支条件', '分支结果', '变化'],
  change: ['路径', '操作', '值'],
  index: ['说明', '事件'],
});

export const CHARACTER_POSITION = freeze({
  required: ['事件ID', '角色组ID', '角色概要', '角色定位'],
  optional: ['适用分支', '介入条件', '角色知情', '主观记忆', '事件触发语料'],
  dialogue: ['触发情境', '表达目的', '情绪或语气', '候选台词', '触发限制'],
});

export const STORYLINE = freeze({index: ['剧情线'], fields: ['剧情线ID', '名称', '概述', '事件', '引用']});

// 事件分类的默认词表；方言可整表替换。
export const CLASSIFICATION = freeze({
  主类型: ['世界', '关系', '个人'],
  标签: ['战斗', '政治', '灾难', '成长', '家庭', '教育', '迁移', '知识', '身份', '伤势', '生育', '死亡', '谈判', '救援'],
  事件结果: ['关系变化', '能力变化', '身份变化', '知识变化', '职位变化', '身体状态变化', '资产变化', '地缘变化', '剧情条件变化'],
});

export const ROLE_INDEX = freeze({fields: ['角色组ID', '角色包', '分类', '入口']});
export const GROUP_INDEX = freeze({
  fields: ['角色组ID', '显示名', '别名', '默认启用', '默认版本', '版本', '档案'],
  key_order: ['角色组ID', '显示名', '别名', '默认启用', '默认版本', '初始成长登记', '版本', '档案'],
  initialization_modes: INITIALIZATION_MODES,
  profile_fields: ['档案ID', '版本ID', '适用版本', '默认', '前置档案', '生效条件', '初始成长'],
});
export const PROFILE_FILES = freeze(['基本信息', '角色印象']);

// 档案形态：键顺序即字段顺序。
export const PROFILE_SHAPES = freeze({
  基本信息: {
    姓名: {必填: true, 形态: '文本'},
    称号: {形态: '短语列表'},
    性别: {必填: true, 形态: '文本'},
    出生年: {形态: '年份'},
    种族: {必填: true, 形态: '文本'},
    出身: {必填: true, 形态: '文本'},
    稳定体貌: {必填: true, 形态: '映射', 子字段: {
      发色发型: {形态: '文本'}, 瞳色: {形态: '文本'}, 体型: {形态: '文本'}, 特征: {形态: '短语列表'},
    }},
    穿着习惯: {形态: '文本列表'},
    能力特征: {必填: true, 形态: '能力特征'},
  },
  角色印象: {
    核心身份: {必填: true, 形态: '短语列表', 建议条数: [1, 3]},
    行为准则: {必填: true, 形态: '文本列表', 建议条数: [2, 4]},
    价值优先: {必填: true, 形态: '短语列表', 建议条数: [2, 4]},
    表达规律: {必填: true, 形态: '映射', 子字段: {
      自称与称呼: {形态: '文本'}, 句式: {形态: '文本列表'}, 语气变化: {形态: '情境列表'},
      场合差异: {形态: '情境列表'}, 内外差: {形态: '文本列表'}, 口头特征: {形态: '短语列表', 最长: 8},
    }},
    通用反应: {必填: true, 形态: '情境列表', 建议条数: [2, 5]},
    关系表现: {形态: '情境列表', 建议条数: [1, 5]},
    表现禁区: {必填: true, 形态: '禁区列表', 建议条数: [1, 4]},
  },
});

export const TRAITS = freeze({fields: ['特征', '技能补充'], skill_override: ['技能ID', '个体表现', '个体限制']});

export const GROWTH = freeze({
  tree: ['角色组ID', '版本', '说明', '根节点', '节点'],
  node: ['节点ID', '名称', '节点类型', '适用版本', '上级节点', '核定状态', '运行效果', '能力效果', '取得效果', '待核定效果', '说明'],
  review: ['已核定', '待承接事件', '待核定'],
  effect: ['激活', '不激活'],
  ability: ['修习阶段', '实力定位', '固有技能新增', '施法方式新增'],
  equipment_gain: ['装备ID', '状态', '位置'],
});

// 能力模型 v1：体系段位、综合实力标量、两个掌握集合。字段由协议维护，变化表只能按能力契约改动。
export const ABILITY = freeze({
  stages: '修习阶段', strength: '实力定位', sets: ['固有技能', '施法方式'],
  activated: '成长节点已激活', removed: '能力移除记录', initialized: '成长已初始化',
  retired: ['固有技能新增', '固有技能移除', '施法方式新增'],
  skill_sources: ['一般', '固有'],
});

// 本局角色状态中输出给模型的字段；方言可在“运行变量.输出字段”替换。
export const PROJECTED_ROLE_FIELDS = freeze(['关系', '好感度', '亲密度', '职位', '身体状态', '身体形态', '知识', '装备', '道具', '资产']);

// 世界书根目录布局（相对世界书根）。
export const LAYOUT = freeze({
  roleIndex: '角色/角色索引.txt',
  growthTree: '成长树.yaml',
  historyIndex: '历史/历史索引.txt',
  storylineIndex: '剧情线索引.txt',
  eventIndex: '事件/事件索引.txt',
  eventRoot: '历史/事件',
  skillIndex: '战斗/技能/技能索引.txt',
  systemsMeta: '战斗/技能/体系元数据.txt',
  equipmentIndex: '战斗/装备/装备索引.txt',
  geographyIndex: '地理/地理索引.txt',
  variableSchema: '变量/变量结构.yaml',
  vocabulary: '变量/词表.yaml',
  indexSuffix: '索引.txt',
});

// 命名空间：引用所在字段决定命名空间，同一命名空间内全局唯一。
export const NAMESPACES = freeze(['技能ID', '装备ID', '道具ID', '货币ID', '服务ID', '地点ID', '势力ID', '生物ID']);

// 模型可见正文的通用禁用词：运行实现术语与作者维护规则。来源标签等作品用语在方言补充。
export const FORBIDDEN_TERMS = freeze(['stat_data', '变量', 'schema', '索引', '路由', 'ID', '状态[012]', '候选事件', '额外模型', '冲突队列', '条目', '注册', '挂载', '加载', '目录',
  '记录规则', '目录规则', '统一格式', '登记规则', '引用边界', '记录边界', '维护']);
// 同名说明文件额外禁止系统视角措辞。
export const SYSTEM_VOICE = /模块|读取|登记|记录|资料|写入|本文件|运行状态|定义|依据|入口/;
export const LENGTH_BUDGET = freeze({同名说明: 300, 基本信息: 500, 角色印象: 600, 事件: 800});

export const CONTEXT_DEFAULTS = freeze({historyLimit: 6, historyCharBudget: 3000, candidateLimit: 4, candidateCharBudget: 4000, skillLimit: 6});
