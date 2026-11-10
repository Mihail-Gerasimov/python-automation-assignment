// Назначение: выбор профиля и инструкций для ограниченного поручения координатора.
import { readFileSync } from 'node:fs';

export const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

const modes = ['inspect', 'plan', 'implement', 'review', 'verify'];
const changes = ['none', 'text', 'cosmetic', 'behavior', 'refactor'];
const signals = ['product', 'conversion', 'ui', 'behavior', 'code'];
const risks = [
  'permissions',
  'money',
  'migration',
  'concurrency',
  'cross-module',
  'architecture',
  'uncertainty',
];

// Старые записи сохраняют фактический маршрут; новые запуски отдельно проходят актуальную политику.
export function validateTask(task, { historical = false } = {}) {
  if (!modes.includes(task.mode) || !changes.includes(task.change))
    throw new Error('Неизвестный режим/вид изменения');
  for (const [values, allowed] of [
    [task.signals, signals],
    [task.risks, risks],
  ]) {
    if (!Array.isArray(values) || values.some((value) => !allowed.includes(value)))
      throw new Error('Неизвестный признак задачи');
  }
  if (!['read-only', 'workspace-write'].includes(task.access))
    throw new Error('Нужен явный доступ');
  if (['inspect', 'review', 'verify'].includes(task.mode) && task.access !== 'read-only')
    throw new Error('Проверка не разрешает запись');
  if (task.profile && !config.profiles[task.profile] && !(historical && task.profile === 'deep'))
    throw new Error('Неизвестный или снятый профиль');
  if (task.profile && !described(task.reason))
    throw new Error('Переопределение профиля требует причины');
}

function described(value) {
  return typeof value === 'string' && value.trim().length >= 10;
}

export function isAstraProfile(profile) {
  // deep остаётся только в истории и занимает слот, пока прежний запуск не завершён.
  return profile === 'architect' || profile === 'deep';
}

// Astra получает отдельный вопрос; её effort ограничен действующим словарём.
function validateEscalation(task, profile) {
  const escalation = task.escalation;
  if (
    escalation?.requestedEffort !== undefined &&
    escalation.requestedEffort !== config.profiles[profile].effort
  )
    throw new Error(
      `Запрошенный effort Astra не соответствует разрешённому ${config.profiles[profile].effort}`,
    );
  if (!escalation || typeof escalation !== 'object' || Array.isArray(escalation))
    throw new Error('Astra требует явное основание escalation');
  if (escalation.kind === 'user-request') {
    if (!described(escalation.instruction))
      throw new Error('Нужна цитата прямого указания пользователя о модели/effort');
    return;
  }
  if (!['inspect', 'plan', 'review'].includes(task.mode) || task.access !== 'read-only')
    throw new Error(
      'Без указания пользователя Astra разрешена только для чтения: inspect/plan/review',
    );
  if (escalation.kind === 'architecture-decision') {
    const options = escalation.options;
    if (!task.risks.includes('architecture')) throw new Error('Нет архитектурного основания');
    if (
      !Array.isArray(options) ||
      options.some((option) => typeof option !== 'string' || !option.trim()) ||
      new Set(options.map((option) => option.trim())).size < 2
    )
      throw new Error('Архитектурный выбор требует минимум два разных варианта');
  } else if (escalation.kind === 'sol-blocked') {
    if (!described(escalation.evidence))
      throw new Error('Нужен конкретный результат работы Sol и оставшаяся проблема');
  } else throw new Error('Неизвестное основание подключения Astra');
}

// Любой риск повышает достаточную проверку до Sol/high, но сам по себе не запускает Astra.
export function route(task) {
  validateTask(task);
  const has = (signal) => task.signals.includes(signal);
  let minimum = 'standard';
  if (task.mode === 'inspect' && task.risks.length === 0) minimum = 'scan';
  if (task.risks.length) minimum = 'critical';
  const profile = task.profile ?? minimum;
  const chosen = config.profiles[profile];
  if (!chosen || chosen.rank < config.profiles[minimum].rank)
    throw new Error('Профиль ниже допустимого для риска');
  if (chosen.scope === 'coordinator')
    throw new Error('Ultra предназначен основному координатору, а не вложенному помощнику');
  if (isAstraProfile(profile)) validateEscalation(task, profile);
  else if (task.escalation !== undefined)
    throw new Error('Основание Astra указано без явного профиля architect');
  const skills = ['orchestration'];
  if (task.mode === 'plan' && has('product')) skills.push('product-planning');
  if (task.mode === 'plan' && has('conversion')) skills.push('product-marketing');
  if (has('ui')) skills.push('visual-design');
  if (
    (task.mode === 'plan' && has('behavior')) ||
    (task.mode === 'implement' && task.change === 'behavior')
  )
    skills.push('tdd');
  if (
    task.mode === 'implement' &&
    has('code') &&
    ['behavior', 'refactor', 'cosmetic'].includes(task.change)
  )
    skills.push('code-simplifier');
  return { profile, ...chosen, skills };
}
