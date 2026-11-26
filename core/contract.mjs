import {freeze} from './utils.mjs';

export const FIXED_ROOTS = freeze(['角色', '历史', '设定']);
export const TEXT_CONTAINERS = freeze(['世界概况', '扮演准则']);
export const RESERVED_IDS = freeze(['玩家', '__proto__', 'constructor', 'prototype']);
export const DECLARATION_FILES = freeze(['纪年', '等级', '能力', '事件分类', '条目库', '本局变量', '剧情标记', '角色分类', '文本规范']);
export const REQUIRED_DECLARATIONS = freeze(['纪年', '事件分类', '本局变量']);
export const SKELETON_FIELDS = freeze({
  角色: ['在场', '所在', '装备', '能力移除记录', '已初始化'],
  世界: ['当前时间', '当前地点', '剧情标记'],
});
export const FIELD_KINDS = freeze(['形态', '取值', '引用', '子字段', '映射', '数值', '集合']);
export const SHAPES = freeze(['文本', '文本列表', '短语列表', '情境列表', '禁区列表']);
export const GROUP_FIELDS = freeze(['显示名', '别名', '角色包', '分类', '默认启用', '默认版本', '初始化方式', '初始所在', '版本', '档案']);
export const VERSION_FIELDS = freeze(['版本ID', '显示名', '别名', '简介']);
export const PROFILE_ITEM_FIELDS = freeze(['档案ID', '适用版本', '默认', '前置档案', '生效条件', '初始能力', '初始装备']);
export const INITIALIZATION_MODES = freeze(['显式确认', '出场自动']);
export const PROFILE_FIELDS = freeze({
  基本信息: {
    姓名: {必填: true, 形态: '文本'},
    称号: {形态: '短语列表'},
    性别: {必填: true, 形态: '文本'},
    出生年: {取值: '纪年'},
    种族: {必填: true, 形态: '文本'},
    出身: {必填: true, 形态: '文本'},
    稳定体貌: {必填: true, 子字段: {
      发色发型: {形态: '文本'}, 瞳色: {形态: '文本'}, 体型: {形态: '文本'}, 特征: {形态: '短语列表'},
    }},
    穿着习惯: {形态: '文本列表'},
    能力特征: {必填: true, 子字段: {
      特征: {必填: true, 形态: '文本列表'}, 技能补充: {必填: true},
    }},
  },
  角色印象: {
    核心身份: {必填: true, 形态: '短语列表', 建议条数: [1, 3]},
    行为准则: {必填: true, 形态: '文本列表', 建议条数: [2, 4]},
    价值优先: {必填: true, 形态: '短语列表', 建议条数: [2, 4]},
    表达规律: {必填: true, 子字段: {
      自称与称呼: {形态: '文本'}, 句式: {形态: '文本列表'}, 语气变化: {形态: '情境列表'},
      场合差异: {形态: '情境列表'}, 内外差: {形态: '文本列表'}, 口头特征: {形态: '短语列表', 最长: 8},
    }},
    通用反应: {必填: true, 形态: '情境列表', 建议条数: [2, 5]},
    关系表现: {形态: '情境列表', 建议条数: [1, 5]},
    表现禁区: {必填: true, 形态: '禁区列表', 建议条数: [1, 4]},
  },
});

export const CONFIRMATION_POLICIES = freeze(['自动确认', '条件确认', '仅作候选']);
export const CONDITION_COMBINATORS = freeze(['all', 'any', 'none']);
export const CONDITION_TYPES = freeze(['角色启用', '角色版本', '事件确认', '事件串状态', '当前时间', '剧情标记', '角色状态', '同处', '角色已出场', '当前场景', '在场实力人数', '世界线']);
export const UNSEALABLE_CONDITIONS = freeze(['当前场景', '在场实力人数']);
export const EVENT_FIELDS = freeze(['事件ID', '事件标题', '事件概要', '主类型', '标签', '事件结果', '影响范围', '触发时间', '地点', '确认策略', '核心参与者', '门槛', '关联事件', '叙事条件', '公开信息', '隐秘信息', '默认分支', '分支']);
export const EVENT_BRANCH_FIELDS = freeze(['分支ID', '门槛', '分支条件', '分支结果', '事件概要', '影响范围', '公开信息', '隐秘信息', '变化']);
export const POSITION_FIELDS = freeze(['事件ID', '角色组ID', '角色概要', '角色定位', '适用分支', '介入条件', '角色知情', '主观记忆', '按分支', '事件触发语料']);
export const DIALOGUE_FIELDS = freeze(['触发情境', '候选台词', '表达目的', '情绪或语气', '触发限制']);
export const CHAIN_FIELDS = freeze(['概述', '事件', '结局']);
export const WORLDLINE_FIELDS = freeze(['概述', '默认', '角色组']);
export const OPENING_OPTION_FIELDS = freeze(['自由组合', '选项']);
export const OPENING_PLAN_FIELDS = freeze(['世界线', '概述', '开局时间', '开局地点', '角色组', '历史选择']);
export const FORBIDDEN_TERMS = freeze(['stat_data', '变量', 'schema', '索引', '路由', 'ID', '状态0', '状态1', '状态2',
  '状态0/1/2', '候选事件', '额外模型', '冲突队列', '条目', '注册', '挂载', '加载', '目录',
  '记录规则', '目录规则', '统一格式', '登记规则', '引用边界', '记录边界', '维护']);
export const SYSTEM_TERMS = freeze(['模块', '读取', '登记', '记录', '资料', '写入', '本文件', '运行状态', '定义', '依据', '入口']);
export const WRITING_TERMS = freeze(['似乎', '几乎', '仿佛', '如同', '宛如', '嘴角微微上扬', '眼中闪过一丝', '心湖泛起涟漪', '万念俱灰']);
export const LENGTH_BUDGETS = freeze({同名说明: 300, 基本信息: 500, 角色印象: 600, 事件: 800});
export const MACHINE_FIELDS = freeze(['门槛', '确认策略', '默认分支', '变化', '前置档案', '生效条件', '默认', '适用分支', '适用版本', '关联事件']);
