import {RESERVED_IDS} from './contract.mjs';

export function isValidIdShape(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[./\\]/u.test(value);
}

export function isValidId(value) {
  return isValidIdShape(value) && !RESERVED_IDS.includes(value);
}
