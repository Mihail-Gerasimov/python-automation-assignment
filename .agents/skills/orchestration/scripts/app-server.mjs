// Назначение: транспорт Codex App Server и явный контракт запуска поручения.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { basename, dirname } from 'node:path';

// Каталог подтверждает имя и effort, но не гарантирует квоту или успешный модельный запуск.
export function validateModel(models, profile) {
  const model = models.find((item) => item.model === profile.model);
  if (!model?.supportedReasoningEfforts?.some((item) => item.reasoningEffort === profile.effort)) {
    throw new Error(`Недоступен профиль ${profile.model}/${profile.effort}; тихой подмены нет`);
  }
}

export function turnParams(task, threadId) {
  const {
    id,
    goal,
    mode,
    change,
    signals,
    risks,
    files,
    checks,
    access,
    retryReason,
    reason,
    escalation,
  } = task;
  const contract = {
    id,
    goal,
    mode,
    change,
    signals,
    risks,
    files,
    checks,
    access,
    retryReason,
    reason,
    escalation,
  };
  const input = [
    {
      type: 'text',
      text: `ORCHESTRATION_WORKER\nВыполни только поручение ниже, без своего диспетчера/подагентов. Прочитай назначенные скиллы и AGENTS. Не трогай production, Git, рабочие БД/данные, env, служебную очередь и стенд; не запускай фоновые процессы. Разрешённые файлы — граница задачи, не техническая файловая ACL. Режим plan не разрешает код приложения; read-only не разрешает исправления. Верни кратко: результат, файлы, фактические проверки, ограничения и прочитанные справочники.\n${JSON.stringify(contract)}`,
    },
  ];
  for (const path of Object.keys(task.instructions)) {
    if (basename(path) === 'SKILL.md')
      input.push({ type: 'skill', name: basename(dirname(path)), path });
  }
  return {
    threadId,
    model: task.route.model,
    effort: task.route.effort,
    input,
    approvalPolicy: 'never',
    sandboxPolicy:
      task.access === 'read-only'
        ? { type: 'readOnly', networkAccess: false }
        : { type: 'workspaceWrite', networkAccess: false },
  };
}

export class AppServer extends EventEmitter {
  constructor({
    cwd,
    command = 'codex',
    args = ['app-server', '--listen', 'stdio://', '-c', 'agents.enabled=false'],
  }) {
    super();
    this.sequence = 0;
    this.pending = new Map();
    this.completed = new Map();
    this.active = new Map();
    this.messages = new Map();
    this.child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.once('error', (error) => this.fail(error));
    this.exited = new Promise((resolve) =>
      this.child.once('close', (code) => {
        this.fail(new Error(`App Server завершился (${code})`));
        resolve();
      }),
    );
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch (error) {
        this.fail(error);
      }
    });
  }

  fail(error) {
    this.failure = error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.emit('transportFailure', error);
  }

  receive(message) {
    if ('id' in message && !message.method) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
      return;
    }
    if ('id' in message) {
      // Автоматизация не подтверждает новые доступы, пользовательские ответы или внешние действия.
      this.send({
        id: message.id,
        error: {
          code: -32000,
          message: 'Нужно решение координатора; автоматическое подтверждение запрещено',
        },
      });
      return;
    }
    const params = message.params ?? {};
    if (message.method === 'turn/started') this.active.set(params.threadId, params.turn.id);
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage')
      this.messages.set(params.threadId, params.item.text.slice(-8000));
    if (message.method === 'turn/completed') {
      this.active.delete(params.threadId);
      this.completed.set(`${params.threadId}/${params.turn.id}`, {
        ...params.turn,
        summary: this.messages.get(params.threadId) ?? '',
      });
    }
    this.emit('notification', message);
  }

  send(value) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  request(method, params = {}, timeoutMs = 30000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Тайм-аут RPC ${method}; исход требует сверки`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'project_orchestration', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
  }

  async models() {
    const models = [];
    let cursor;
    do {
      const page = await this.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }

  waitForTurn(threadId, turnId, timeoutMs = 900000) {
    const key = `${threadId}/${turnId}`;
    if (this.completed.has(key)) return Promise.resolve(this.completed.get(key));
    return new Promise((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer);
        this.off('notification', check);
        this.off('transportFailure', failed);
      };
      const check = () => {
        if (this.completed.has(key)) {
          clear();
          resolve(this.completed.get(key));
        }
      };
      const failed = (error) => {
        clear();
        reject(error);
      };
      const timer = setTimeout(() => {
        clear();
        reject(new Error('Поручение превысило время; требуется сверка результата'));
      }, timeoutMs);
      this.on('notification', check);
      this.on('transportFailure', failed);
      if (this.failure) failed(this.failure);
      else check();
    });
  }

  // Прерывание RPC само по себе не доказывает остановку: проверяем turn и собственные терминалы.
  async stopThread(threadId, turnId = this.active.get(threadId)) {
    if (turnId && !this.completed.has(`${threadId}/${turnId}`)) {
      await this.request('turn/interrupt', { threadId, turnId }, 5000);
      await this.waitForTurn(threadId, turnId, 5000);
    }
    let cursor;
    do {
      const page = await this.request(
        'thread/backgroundTerminals/list',
        { threadId, limit: 100, ...(cursor ? { cursor } : {}) },
        5000,
      );
      for (const terminal of page.data) {
        const result = await this.request(
          'thread/backgroundTerminals/terminate',
          { threadId, processId: terminal.processId },
          5000,
        );
        if (!result.terminated) throw new Error('Остановка собственного терминала не подтверждена');
      }
      cursor = page.nextCursor;
    } while (cursor);
    const remaining = await this.request(
      'thread/backgroundTerminals/list',
      { threadId, limit: 1 },
      5000,
    );
    if (remaining.data.length) throw new Error('У потока ещё остались терминалы');
  }

  async close() {
    this.child.stdin.end();
    const signal = (name) => {
      if (!this.child.pid) return;
      try {
        process.kill(process.platform === 'win32' ? this.child.pid : -this.child.pid, name);
      } catch (error) {
        if (error.code !== 'ESRCH') this.fail(error);
      }
    };
    const terminate = setTimeout(() => signal('SIGTERM'), 1000);
    const kill = setTimeout(() => signal('SIGKILL'), 3000);
    try {
      await this.exited;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
      this.lines.close();
    }
  }
}
