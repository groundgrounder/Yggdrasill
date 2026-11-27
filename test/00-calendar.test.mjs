import {test, assert} from './helpers.mjs';
import {createCalendar} from '../core/calendar.mjs';

const declaration = {前缀: '潮历', 年位数: 3, 月数: 4, 每月天数: [91, 91, 91, 92]};
const calendar = createCalendar(declaration);
test('纪年-1：整年为半开区间', () => assert.deepEqual(calendar.time('潮历012年'), [12 * 365, 13 * 365]));
test('纪年-2：逐月天数和年末日期', () => {
  assert.deepEqual(calendar.time('潮历012年04月92日'), [13 * 365 - 1, 13 * 365]);
  assert.equal(calendar.time('潮历012年01月92日'), null);
});
test('纪年-3：拒绝缺位年、越界月和仅到月', () => {
  for (const value of ['潮历12年', '潮历012年05月01日', '潮历012年03月']) assert.equal(calendar.time(value), null);
});
test('纪年-4：格式化和年份互逆', () => {
  assert.equal(calendar.format(12), '潮历012年');
  for (let year = 0; year <= 999; year++) assert.equal(calendar.year(calendar.format(year)), year);
});
test('纪年补充：整数月长、字面前缀、纪元前与非法年份', () => {
  const calendar = createCalendar({前缀: '历(甲)+', 年位数: 2, 月数: 2, 每月天数: 30});
  assert.deepEqual(calendar.time('历(甲)+00年02月30日'), [59, 60]);
  assert.equal(calendar.format(-1), '历(甲)+前01年');
  assert.equal(calendar.year('历(甲)+前01年'), -1);
  assert.equal(calendar.time('历(甲)+前00年'), null);
  for (const value of [-100, 100, 1.5, NaN, '12']) assert.equal(calendar.format(value), null);
  assert.equal(calendar.time(null), null);
  assert.throws(() => createCalendar({前缀: '潮历'}));
});
