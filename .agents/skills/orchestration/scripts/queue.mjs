// Назначение: атомарная файловая очередь поручений; статусы фаз остаются в документах проекта.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { config, isAstraProfile, route, validateTask } from './policy.mjs';

const skillsDir = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const configPath = fileURLToPath(new URL('../config.json', import.meta.url));
const statuses = new Set(['pending', 'running', 'awaiting_review', 'needs_review', 'accepted']);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8000)
    throw new Error(`Нужно непустое поле ${name}`);
  return value.trim();
}

function identifier(value, name) {
  const result = text(value, name);
  if (result.length > 128 || /[\s/\\\0]/u.test(result))
    throw new Error(`Недопустимый идентификатор ${name}`);
  return result;
}

function strings(value, name) {
  if (!Array.isArray(value)) throw new Error(`Нужен массив ${name}`);
  return [...new Set(value.map((item) => text(item, name)))];
}

function stat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function readFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Нужен обычный файл: ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Один writer используется очередью и внешним stop-маркером; каталоги готовит вызывающий код.
export function writeAtomic(path, value) {
  const directory = dirname(path);
  const info = stat(directory);
  const target = stat(path);
  if (
    !info?.isDirectory() ||
    info.isSymbolicLink() ||
    (target && (!target.isFile() || target.isSymbolicLink()))
  )
    throw new Error('Небезопасный путь атомарной записи');
  const data = JSON.stringify(value, null, 2);
  if (data === undefined) throw new Error('Нужен сериализуемый JSON');
  const temporary = join(directory, `${basename(path)}.${randomUUID()}.tmp`);
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, data + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(directory);
  } finally {
    if (stat(temporary)) unlinkSync(temporary);
  }
}

// Разрешение выдаётся точному файлу, а не каталогу, шаблону или неявно нормализованному пути.
function fileName(value, access) {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    isAbsolute(value) ||
    /[\\\0*?]/u.test(value)
  ) {
    throw new Error('Нужен точный относительный путь файла');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error('Выход из проекта или неоднозначный путь');
  const lower = parts.map((part) => part.toLowerCase());
  const name = basename(value).toLowerCase();
  if (
    access === 'workspace-write' &&
    (lower.some((part) =>
      ['.git', '.codex', '.agents', '.claude', 'backups', 'secrets', '.ssh'].includes(part),
    ) ||
      ['agents.md', 'skill.md', 'claude.md', 'auth.json', 'credentials.json', '.npmrc'].includes(
        name,
      ) ||
      name === '.env' ||
      name.startsWith('.env.') ||
      /\.(pem|key|p12|pfx)$/u.test(name))
  )
    throw new Error(`Служебный файл, инструкция или секрет не разрешён на запись: ${value}`);
  return value;
}

export class Queue {
  constructor(root) {
    this.root = realpathSync(resolve(root));
    if (!stat(this.root)?.isDirectory()) throw new Error('Корень проекта должен быть каталогом');
    this.dir = join(this.root, '.codex', 'orchestration');
    this.path = join(this.dir, 'queue.json');
    this.lockPath = join(this.dir, 'queue.lock');
    this.owner = null;
  }

  // Проверяем служебный путь отдельно: симлинк в .codex не должен перенести запись наружу.
  location(create = false) {
    for (const path of [this.root, join(this.root, '.codex'), this.dir]) {
      const info = stat(path);
      if (!info && create) mkdirSync(path, { mode: 0o700 });
      else if (info && (!info.isDirectory() || info.isSymbolicLink()))
        throw new Error(`Небезопасный каталог очереди: ${path}`);
    }
    const info = stat(this.path);
    if (info && (!info.isFile() || info.isSymbolicLink()))
      throw new Error('Очередь должна быть обычным файлом');
  }

  file(file, access) {
    const root = stat(this.root);
    if (!root?.isDirectory() || root.isSymbolicLink()) throw new Error('Корень проекта изменился');
    const parts = fileName(file, access).split('/');
    let path = this.root;
    for (let index = 0; index < parts.length; index++) {
      path = join(path, parts[index]);
      const info = stat(path);
      if (!info) break;
      if (info.isSymbolicLink()) throw new Error(`Символическая ссылка не разрешена: ${file}`);
      if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
        throw new Error(`Нужен точный путь обычного файла: ${file}`);
    }
    return join(this.root, ...parts);
  }

  validate(state) {
    if (
      !state ||
      state.version !== 1 ||
      state.root !== this.root ||
      typeof state.paused !== 'boolean' ||
      !Array.isArray(state.tasks) ||
      state.tasks.length > 128
    )
      throw new Error('Повреждённая очередь, неверная версия или корень');
    const ids = new Set();
    for (const task of state.tasks) {
      identifier(task.id, 'id');
      identifier(task.batch, 'batch');
      identifier(task.step, 'step');
      text(task.goal, 'goal');
      if (
        ids.has(task.id) ||
        !statuses.has(task.status) ||
        !['read-only', 'workspace-write'].includes(task.access)
      )
        throw new Error('Повтор ID или неверное состояние поручения');
      ids.add(task.id);
      for (const key of ['files', 'checks', 'dependsOn', 'signals', 'risks'])
        strings(task[key], key);
      validateTask(task, { historical: true });
      if (
        !task.files.length ||
        !task.checks.length ||
        !Number.isInteger(task.maxAttempts) ||
        task.maxAttempts < 1 ||
        task.maxAttempts > 3 ||
        !Array.isArray(task.attempts) ||
        task.attempts.length > task.maxAttempts
      )
        throw new Error('Повреждённый контракт или история попыток');
      task.files.forEach((file) => fileName(file, task.access));
      if (
        !task.route ||
        !Array.isArray(task.route.skills) ||
        !task.route.skills.includes('orchestration') ||
        typeof task.route.model !== 'string' ||
        !task.route.model ||
        typeof task.route.effort !== 'string' ||
        !task.route.effort ||
        !task.instructions ||
        Array.isArray(task.instructions) ||
        !Object.keys(task.instructions).length ||
        Object.entries(task.instructions).some(
          ([path, hash]) => !isAbsolute(path) || !/^[a-f0-9]{64}$/u.test(hash),
        )
      )
        throw new Error('Нет профиля или снимка обязательных инструкций');
      const attempts = new Set();
      for (const attempt of task.attempts) {
        if (!attempt || typeof attempt.id !== 'string' || !attempt.id || attempts.has(attempt.id))
          throw new Error('Повреждённая попытка');
        attempts.add(attempt.id);
      }
    }
    for (const task of state.tasks) {
      for (const id of task.dependsOn) {
        const dependency = state.tasks.find((item) => item.id === id);
        if (!dependency || id === task.id || dependency.batch !== task.batch)
          throw new Error('Зависимость должна быть в том же batch');
      }
      if (task.reviews) {
        const writer = state.tasks.find((item) => item.id === task.reviews);
        if (
          !writer ||
          writer.id === task.id ||
          writer.batch !== task.batch ||
          writer.step !== task.step ||
          writer.access !== 'workspace-write' ||
          task.mode !== 'review' ||
          task.access !== 'read-only' ||
          !task.dependsOn.includes(writer.id) ||
          writer.files.some((file) => !task.files.includes(file))
        )
          throw new Error('Некорректная связь reviews');
      }
    }
    return state;
  }

  load() {
    this.location();
    try {
      return this.validate(JSON.parse(readFile(this.path).toString('utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, root: this.root, paused: false, tasks: [] };
      throw error;
    }
  }

  readOwner() {
    const info = stat(this.lockPath);
    if (!info?.isDirectory() || info.isSymbolicLink())
      throw new Error('Небезопасный или отсутствующий lock');
    const owner = JSON.parse(readFile(join(this.lockPath, 'owner.json')).toString('utf8'));
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      typeof owner.nonce !== 'string' ||
      !owner.nonce ||
      typeof owner.host !== 'string'
    )
      throw new Error('Неизвестный владелец lock; требуется ручная сверка');
    return owner;
  }

  assertOwner() {
    const actual = this.readOwner();
    if (
      !this.owner ||
      actual.pid !== this.owner.pid ||
      actual.nonce !== this.owner.nonce ||
      actual.host !== this.owner.host
    )
      throw new Error('Владение lock потеряно');
  }

  removeLock(owner) {
    const actual = this.readOwner();
    if (
      !isDeepStrictEqual(actual, owner) ||
      readdirSync(this.lockPath).some((file) => file !== 'owner.json')
    )
      throw new Error('Lock изменился или содержит чужие файлы');
    unlinkSync(join(this.lockPath, 'owner.json'));
    rmdirSync(this.lockPath);
    syncDirectory(this.dir);
  }

  acquire() {
    if (this.owner) throw new Error('Этот экземпляр уже держит lock');
    this.location(true);
    try {
      mkdirSync(this.lockPath, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error('Очередь заблокирована; автоматическое снятие lock запрещено');
      throw error;
    }
    const owner = {
      pid: process.pid,
      nonce: randomUUID(),
      host: hostname(),
      createdAt: new Date().toISOString(),
    };
    const ownerPath = join(this.lockPath, 'owner.json');
    try {
      const fd = openSync(
        ownerPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, JSON.stringify(owner));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDirectory(this.lockPath);
      syncDirectory(this.dir);
    } catch (error) {
      if (stat(ownerPath)?.isFile()) unlinkSync(ownerPath);
      rmdirSync(this.lockPath);
      throw error;
    }
    this.owner = owner;
    let released = false;
    return () => {
      if (released) return;
      this.assertOwner();
      this.removeLock(owner);
      this.owner = null;
      released = true;
    };
  }

  // Публикуем только fsync-нутый полный JSON, затем закрепляем rename в каталоге.
  save(state) {
    const release = this.owner ? null : this.acquire();
    try {
      this.assertOwner();
      this.validate(state);
      this.location(true);
      // Даже прямой save не заменяет повреждённое или чужое состояние новой пустой очередью.
      if (stat(this.path)) this.load();
      writeAtomic(this.path, state);
      this.assertOwner();
    } finally {
      release?.();
    }
  }

  mutate(fn) {
    const release = this.owner ? null : this.acquire();
    try {
      this.assertOwner();
      const state = this.load();
      const result = fn(state);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new Error('Мутация очереди должна быть синхронной');
      }
      this.save(state);
      return result;
    } finally {
      release?.();
    }
  }

  instructions(task) {
    const paths = [join(this.root, 'AGENTS.md'), configPath];
    for (const name of task.route.skills) {
      const entry = config.skills[name];
      if (typeof entry !== 'string' || isAbsolute(entry))
        throw new Error(`Нет обязательного скилла ${name}`);
      const path = realpathSync(resolve(skillsDir, entry));
      if (relative(skillsDir, path).startsWith('..') || !relative(skillsDir, path))
        throw new Error('Скилл вышел из каталога инструкций');
      paths.push(path);
    }
    return Object.fromEntries(paths.map((path) => [path, sha256(readFile(path))]));
  }

  snapshot(task) {
    return Object.fromEntries(
      task.files.map((file) => {
        const path = this.file(file, task.access);
        try {
          return [file, sha256(readFile(path))];
        } catch (error) {
          if (error.code === 'ENOENT') return [file, null];
          throw error;
        }
      }),
    );
  }

  current(task, snapshot = task.outputSnapshot) {
    try {
      return (
        !!snapshot &&
        isDeepStrictEqual(task.instructions, this.instructions(task)) &&
        isDeepStrictEqual(snapshot, this.snapshot(task))
      );
    } catch {
      return false;
    }
  }

  enqueue(raw) {
    return this.mutate((state) => {
      if (state.tasks.length >= 128) throw new Error('Достигнут предел 128 поручений');
      const task = {
        id: identifier(raw.id, 'id'),
        batch: identifier(raw.batch, 'batch'),
        step: identifier(String(raw.step ?? ''), 'step'),
        goal: text(raw.goal, 'goal'),
        mode: raw.mode,
        change: raw.change,
        signals: strings(raw.signals ?? [], 'signals'),
        risks: strings(raw.risks ?? [], 'risks'),
        files: strings(raw.files, 'files'),
        checks: strings(raw.checks, 'checks'),
        dependsOn: strings(raw.dependsOn ?? [], 'dependsOn'),
        access: raw.access,
        maxAttempts: raw.maxAttempts ?? 2,
        status: 'pending',
        attempts: [],
      };
      if (raw.profile != null) task.profile = text(raw.profile, 'profile');
      if (raw.reason != null) task.reason = text(raw.reason, 'reason');
      if (raw.escalation != null) task.escalation = structuredClone(raw.escalation);
      if (raw.reuseFrom != null) task.reuseFrom = identifier(raw.reuseFrom, 'reuseFrom');
      if (raw.reviews != null) {
        task.reviews = identifier(raw.reviews, 'reviews');
        const writer = state.tasks.find((item) => item.id === task.reviews);
        if (!writer) throw new Error('Writer reviews должен уже существовать');
        task.files = [...new Set([...task.files, ...writer.files])];
        task.dependsOn = [...new Set([...task.dependsOn, writer.id])];
      }
      if (state.tasks.some((item) => item.id === task.id)) throw new Error('Повтор ID поручения');
      const batchTasks = state.tasks.filter((item) => item.batch === task.batch);
      const steps = [...new Set(batchTasks.map((item) => item.step))];
      const index = steps.indexOf(task.step);
      if (
        index !== -1 &&
        batchTasks.some((item) => steps.indexOf(item.step) > index && item.attempts.length)
      )
        throw new Error('Нельзя дополнять прежний шаг после запуска следующего');
      task.route = route(task);
      task.files.forEach((file) => this.file(file, task.access));
      task.instructions = this.instructions(task);
      state.tasks.push(task);
      return structuredClone(task);
    });
  }

  ready(state, batch, capacity) {
    this.validate(state);
    if (!Number.isInteger(capacity) || capacity < 0 || capacity > 128)
      throw new Error('Неверная доступная ёмкость');
    if (stat(join(this.dir, 'stop.json'))) return [];
    if (state.paused) return [];
    const tasks = state.tasks.filter((task) => task.batch === batch);
    const step = [...new Set(tasks.map((task) => task.step))].find((value) =>
      tasks.some((task) => task.step === value && task.status !== 'accepted'),
    );
    const holders = state.tasks.filter(
      (task) =>
        task.status === 'running' ||
        (task.access === 'workspace-write' &&
          ['awaiting_review', 'needs_review'].includes(task.status)),
    );
    // Регистр/Unicode и hardlink не должны превратить один файл в независимые разрешения.
    const identities = new Map();
    const keys = (task) => {
      if (!identities.has(task.id)) {
        const values = task.files.flatMap((file) => {
          const info = stat(this.file(file, task.access));
          const pathKey = `path:${file.normalize('NFC').toLowerCase()}`;
          return info ? [pathKey, `inode:${info.dev}:${info.ino}`] : [pathKey];
        });
        identities.set(task.id, new Set(values));
      }
      return identities.get(task.id);
    };
    const astraLimit = config.limits.maxConcurrentAstra;
    if (!Number.isInteger(astraLimit) || astraLimit < 1)
      throw new Error('Неверный предел одновременной работы Astra');
    let astraCount = state.tasks.filter(
      (task) => task.status === 'running' && isAstraProfile(task.route.profile),
    ).length;
    const selected = [];
    for (const task of tasks) {
      if (selected.length >= capacity) break;
      if (task.step !== step || task.status !== 'pending') continue;
      try {
        if (!isDeepStrictEqual(task.route, route(task))) continue;
        if (!isDeepStrictEqual(task.instructions, this.instructions(task))) continue;
      } catch {
        continue;
      }
      if (isAstraProfile(task.route.profile) && astraCount >= astraLimit) continue;
      if (
        !task.dependsOn.every((id) => {
          const dependency = state.tasks.find((item) => item.id === id);
          return (
            this.current(dependency) &&
            (dependency.status === 'accepted' ||
              (task.reviews === id && dependency.status === 'awaiting_review'))
          );
        })
      )
        continue;
      const conflict = [...holders, ...selected].some((other) => {
        if (task.reviews === other.id && other.status === 'awaiting_review' && this.current(other))
          return false;
        return (
          (task.access === 'workspace-write' || other.access === 'workspace-write') &&
          [...keys(task)].some((key) => keys(other).has(key))
        );
      });
      if (!conflict) {
        selected.push(task);
        if (isAstraProfile(task.route.profile)) astraCount++;
      }
    }
    return selected;
  }

  find(state, task) {
    const saved = state.tasks.find(
      (item) => item.id === (typeof task === 'string' ? task : task.id),
    );
    if (!saved) throw new Error('Поручение не найдено');
    return saved;
  }

  // Claim сохраняется до любого внешнего действия; callback получает только новую попытку.
  begin(task) {
    return this.mutate((state) => {
      const saved = this.find(state, task);
      if (
        !this.ready(state, saved.batch, 128).some((item) => item.id === saved.id) ||
        saved.attempts.length >= saved.maxAttempts
      )
        throw new Error('Поручение не готово к запуску');
      const attempt = {
        id: randomUUID(),
        number: saved.attempts.length + 1,
        status: 'running',
        startedAt: new Date().toISOString(),
        inputSnapshot: this.snapshot(saved),
      };
      saved.attempts.push(attempt);
      saved.status = 'running';
      saved.outputSnapshot = null;
      return structuredClone(attempt);
    });
  }

  finish(task, attemptId, result) {
    return this.mutate((state) => {
      const saved = this.find(state, task);
      const attempt = saved.attempts.at(-1);
      if (saved.status !== 'running' || attempt?.id !== attemptId || attempt.status !== 'running')
        throw new Error('Устаревшая или уже завершённая попытка');
      text(result?.status, 'result.status');
      attempt.result = structuredClone(result);
      attempt.status = result.status;
      attempt.finishedAt = new Date().toISOString();
      try {
        saved.outputSnapshot = this.snapshot(saved);
      } catch (error) {
        saved.outputSnapshot = null;
        attempt.snapshotError = error.message;
      }
      attempt.outputSnapshot = saved.outputSnapshot;
      // Штатный агент наследует доступ родителя: проверяем хотя бы объявленные файлы.
      const readOnlyChanged =
        saved.access === 'read-only' &&
        saved.outputSnapshot &&
        !isDeepStrictEqual(attempt.inputSnapshot, saved.outputSnapshot);
      if (readOnlyChanged)
        attempt.scopeViolation = 'Read-only поручение изменило объявленные файлы';
      saved.status =
        result.status === 'completed' && saved.outputSnapshot && !readOnlyChanged
          ? 'awaiting_review'
          : 'needs_review';
      return structuredClone(saved);
    });
  }

  accept(id, evidence) {
    const proof = text(evidence, 'evidence');
    const result = this.mutate((state) => {
      const task = this.find(state, id);
      if (task.status !== 'awaiting_review' || task.attempts.at(-1)?.status !== 'completed')
        throw new Error('Нет завершённого результата для приёмки');
      if (!this.current(task)) {
        task.status = 'needs_review';
        return null;
      }
      task.status = 'accepted';
      task.evidence = proof;
      task.acceptedAt = new Date().toISOString();
      return structuredClone(task);
    });
    if (!result)
      throw new Error('Файлы или инструкции изменились; результат требует повторного разбора');
    return result;
  }

  retry(id, reason) {
    const explanation = text(reason, 'reason');
    return this.mutate((state) => {
      const task = this.find(state, id);
      if (task.status !== 'needs_review' || task.attempts.length >= task.maxAttempts)
        throw new Error('Повтор не разрешён состоянием или лимитом попыток');
      task.route = route(task);
      task.instructions = this.instructions(task);
      task.status = 'pending';
      task.retryReason = explanation;
      task.outputSnapshot = null;
      return structuredClone(task);
    });
  }

  // Восстановление вызывается явно: неизвестный исход не становится разрешением на повтор.
  recover() {
    this.location();
    if (stat(this.lockPath)) {
      const owner = this.readOwner();
      if (owner.host !== hostname()) throw new Error('Lock другого хоста требует ручной сверки');
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') alive = false;
        else throw error;
      }
      if (alive) throw new Error('Живой lock снимать запрещено');
      this.removeLock(owner);
    }
    return this.mutate((state) => {
      for (const task of state.tasks) {
        if (task.status !== 'running') continue;
        task.status = 'needs_review';
        task.outputSnapshot = null;
        const attempt = task.attempts.at(-1);
        if (attempt) {
          attempt.status = 'unknown';
          attempt.recoveredAt = new Date().toISOString();
        }
      }
      return state;
    });
  }
}
