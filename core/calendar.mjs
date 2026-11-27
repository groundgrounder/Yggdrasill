import {has, isMap, isText} from './utils.mjs';

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createCalendar(declaration) {
  const keys = ['前缀', '年位数', '月数', '每月天数'];
  const fail = () => { throw new Error('纪年声明须有合法的前缀、年位数、月数与每月天数'); };
  if (!isMap(declaration) || keys.some(key => !has(declaration, key))
    || Object.keys(declaration).some(key => !keys.includes(key))) fail();
  const prefix = declaration.前缀;
  const digits = declaration.年位数;
  const monthCount = declaration.月数;
  // 年天数最多 99×99=9801；11 位年乘上去仍在安全整数内，12 位会溢出。
  if (!isText(prefix) || prefix !== prefix.trim() || !Number.isSafeInteger(digits) || digits < 1 || digits > 11
    || !Number.isSafeInteger(monthCount) || monthCount < 1 || monthCount > 99) fail();
  const months = Array.isArray(declaration.每月天数) ? [...declaration.每月天数] : Array(monthCount).fill(declaration.每月天数);
  if (months.length !== monthCount || months.some(day => !Number.isSafeInteger(day) || day < 1 || day > 99)) fail();
  const offsets = [0];
  for (const days of months) offsets.push(offsets.at(-1) + days);
  const yearDays = offsets.at(-1);
  const expression = new RegExp(`^${escape(prefix)}(前)?(\\d{${digits}})年(?:(\\d{2})月(\\d{2})日)?$`);
  function time(value) {
    const match = typeof value === 'string' && expression.exec(value);
    if (!match || match[0] !== value) return null;
    const pre = Boolean(match[1]);
    const rawYear = Number(match[2]);
    if (pre && rawYear === 0) return null;
    const yearNum = pre ? -rawYear : rawYear;
    const month = Number(match[3]), day = Number(match[4]);
    if (match[3] && (month < 1 || month > monthCount || day < 1 || day > months[month - 1])) return null;
    const start = yearNum * yearDays + (match[3] ? offsets[month - 1] + day - 1 : 0);
    const end = start + (match[3] ? 1 : yearDays);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) ? [start, end] : null;
  }
  function year(value) {
    const interval = time(value);
    return interval ? Math.floor(interval[0] / yearDays) : null;
  }
  function format(value) {
    if (!Number.isSafeInteger(value)) return null;
    const abs = Math.abs(value);
    if (String(abs).length > digits) return null;
    const result = `${prefix}${value < 0 ? '前' : ''}${String(abs).padStart(digits, '0')}年`;
    return year(result) === value ? result : null;
  }
  function formatDay(value) {
    if (!Number.isSafeInteger(value)) return null;
    const y = Math.floor(value / yearDays);
    const abs = Math.abs(y);
    if (String(abs).length > digits) return null;
    const offset = value - y * yearDays;
    let month = 0;
    while (month < monthCount - 1 && offset >= offsets[month + 1]) month++;
    const result = `${prefix}${y < 0 ? '前' : ''}${String(abs).padStart(digits, '0')}年`
      + `${String(month + 1).padStart(2, '0')}月${String(offset - offsets[month] + 1).padStart(2, '0')}日`;
    return time(result)?.[0] === value ? result : null;
  }
  return {time, year, format, formatDay, yearDays, pattern: `${prefix}${'Y'.repeat(digits)}年[MM月DD日]`};
}
