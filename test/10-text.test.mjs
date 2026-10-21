import {invalidCase, edit, basic, port} from './helpers.mjs';

invalidCase('文本-1甲：通用禁用词条目', '文本.禁用词', root => edit(root, '世界概况/秩序与行当.txt', value => { value.补充 = '每个条目写在海图背面。'; }));
invalidCase('文本-1乙：第五层禁用词原作中', '文本.禁用词', root => edit(root, '世界概况/海况与雾季.txt', value => { value.补充 = '原作中海雾从北边来。'; }));
invalidCase('文本-2：同名地点说明不能写读取', '文本.系统视角', root => edit(root, port, value => { value.概况 += '读取海图可知港口朝向。'; }));
invalidCase('文本-3：说明不用破折号', '文本.破折号', root => edit(root, '装备/装备.txt', value => { value.说明.push('船舷很低——水容易溅进来。'); }));
invalidCase('文本-4：第五层收紧基本信息预算', '文本.长度', root => edit(root, basic, value => { value.出身 = '海'.repeat(401); }), '提示');
invalidCase('文本-5：仿佛只报写法提示', '文本.写法', root => edit(root, '装备/装备.txt', value => { value.说明.push('灯光仿佛连成一线。'); }), '提示');
