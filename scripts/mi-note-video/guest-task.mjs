import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const path = process.argv[2];
const task = JSON.parse(readFileSync(path, 'utf8'));
const attempt = randomUUID();
const state = { attempt, taskId: task.id, pid: process.pid, status: 'running', startedAt: new Date().toISOString() };
const save = () => {
  const temporary = `${task.status}.${attempt}.pending`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
  renameSync(temporary, task.status);
};
save();
const child = spawn(task.command[0], task.command.slice(1), { cwd: task.cwd, env: { ...process.env, ...task.environment }, stdio: 'inherit' });
process.once('SIGTERM', () => child.kill('SIGTERM'));
process.once('SIGINT', () => child.kill('SIGINT'));
child.once('error', error => {
  Object.assign(state, { status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
  save();
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  Object.assign(state, { status: code === 0 ? 'complete' : 'failed', exitCode: code, signal, finishedAt: new Date().toISOString() });
  save();
  process.exitCode = code === 0 ? 0 : 1;
});
