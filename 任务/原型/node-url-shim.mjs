// 浏览器中没有 node:url。core/router.mjs 只在 loadRouter（读本地模板）里用到它，原型不调用 loadRouter。
export function fileURLToPath() {
  throw new Error('原型中不可用：fileURLToPath');
}
