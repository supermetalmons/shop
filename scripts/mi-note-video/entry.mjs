import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Safari } from './safari.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const requested = process.argv[2];
if (!requested) throw new Error('Specify preflight.mjs or capture.mjs.');
const target = isAbsolute(requested) ? resolve(requested) : resolve(directory, requested);
if (!['preflight.mjs', 'capture.mjs'].some(name => target === join(directory, name))) throw new Error('Unexpected native renderer entry point.');
if (!execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim().startsWith('VirtualMac')) throw new Error('Native rendering requires the configured macOS VM.');
if (!process.env.MI_NOTE_JOB_ROOT || !isAbsolute(process.env.MI_NOTE_JOB_ROOT)) throw new Error('MI_NOTE_JOB_ROOT must be an absolute job directory.');
const jobRoot = resolve(process.env.MI_NOTE_JOB_ROOT);
if (realpathSync(jobRoot) !== jobRoot) throw new Error('Job root must not contain a symbolic link.');
const receipts = join(jobRoot, 'screenshot-transfers');
mkdirSync(receipts, { recursive: true });
if (realpathSync(receipts) !== receipts) throw new Error('Screenshot receipt directory must not contain a symbolic link.');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const nativeCall = Safari.prototype.call;
Safari.prototype.call = async function (name, args = {}, timeoutMilliseconds = 65000) {
  if (name !== 'screenshot' || !args.savePath) return nativeCall.call(this, name, args, timeoutMilliseconds);
  const destination = resolve(args.savePath);
  if (!destination.startsWith(jobRoot + sep) || existsSync(destination) || realpathSync(dirname(destination)) !== dirname(destination)) throw new Error('Screenshot destination must be a new regular path inside this job.');
  const temporary = mkdtempSync('/private/tmp/mi-note-native-');
  const source = join(temporary, 'viewport.png');
  const receiptPath = join(receipts, `${randomUUID()}.json`);
  const receipt = { source, destination, createdAt: new Date().toISOString(), passed: false };
  try {
    const result = await nativeCall.call(this, name, { ...args, savePath: source }, timeoutMilliseconds);
    if (!lstatSync(source).isFile()) throw new Error('Native screenshot is not a regular file.');
    receipt.sourceSha256 = hash(source);
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    receipt.destinationSha256 = hash(destination);
    receipt.bytes = lstatSync(destination).size;
    if (receipt.destinationSha256 !== receipt.sourceSha256) throw new Error('Native screenshot transfer changed bytes.');
    receipt.passed = true;
    writeFileSync(receiptPath, JSON.stringify(receipt) + '\n', { flag: 'wx' });
    return result;
  } catch (error) {
    receipt.passed = false;
    receipt.error = error.message;
    if (!existsSync(receiptPath)) writeFileSync(receiptPath, JSON.stringify(receipt) + '\n', { flag: 'wx' });
    throw error;
  } finally {
    if (receipt.passed) rmSync(temporary, { recursive: true, force: true });
  }
};
process.argv = [process.argv[0], target, ...process.argv.slice(3)];
await import(pathToFileURL(target).href);
