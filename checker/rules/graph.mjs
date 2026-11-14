import {analyzeEventTree} from '../../core/graph.mjs';
import {conditionReferences} from '../../core/conditions.mjs';
import {has, list, issue} from '../../core/utils.mjs';

export function checkGraph(catalog, decl) {
  const analysis = analyzeEventTree(catalog, decl);
  const issues = [...analysis.issues];
  for (const event of catalog.events) {
    const file = event.文件;
    for (const branch of list(event.内容?.分支)) {
      const refs = conditionReferences(branch?.门槛).filter(ref => !ref.排斥);
      for (const ref of refs) if (has(event.内容, '触发时间')) {
        // 分支层面的时间检查已由核心图分析完成，这里只保留统一产物接口。
      }
    }
  }
  return {issues, analysis};
}
