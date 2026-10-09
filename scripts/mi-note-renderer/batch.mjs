import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Safari } from './safari.mjs';
import {
  ROOT, TOOL_DIRECTORY, CARD_IDS, CONTROL_IDS, PRESET, now, readJson, fileHash,
  atomicJson, moveDurably, requireSpace, currentSourceHashes, assetFingerprint,
  runFingerprint, assertRun, assertSources, assertGeometry, newCheckpoint, verifyCompleted,
} from './run-state.mjs';

const SNAPSHOT = `const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};const root=document.querySelector('.drif-effect-card'),style=getComputedStyle(root);return {...window.__miNoteCapture.state,innerWidth,innerHeight,dpr:devicePixelRatio,scrollX,scrollY,documentHeight:document.documentElement.scrollHeight,visualViewport:{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,pageTop:visualViewport.pageTop,offsetTop:visualViewport.offsetTop},cardRect:rect('#card'),frameRect:rect('#frame'),actualEffect:{opacity:style.getPropertyValue('--card-opacity'),pointerX:style.getPropertyValue('--pointer-x'),pointerY:style.getPropertyValue('--pointer-y'),shadow:getComputedStyle(document.querySelector('.drif-effect-card__rotator')).boxShadow},actualAssets:{front:document.querySelector('.drif-effect-card__front img').currentSrc,mask:style.getPropertyValue('--mask'),foil:style.getPropertyValue('--foil')}};`;
const VIEWPORT_PROFILE = `import hashlib, io, json, sys
from PIL import Image, ImageCms
with Image.open(sys.argv[1]) as image:
    image.verify()
with Image.open(sys.argv[1]) as image:
    image.load()
    if image.size != (2560, 1716):
        raise ValueError('GEOMETRY: expected a 2560x1716 native viewport screenshot')
    profile = image.info.get('icc_profile')
    if not profile:
        raise ValueError('Native ICC profile missing')
    description = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(profile))).strip()
    print(json.dumps({'sha256': hashlib.sha256(profile).hexdigest(), 'bytes': len(profile), 'description': description}))
`;

export class CaptureRun {
  constructor(options) {
    this.options = options;
    this.output = options.output;
    this.cache = options.cache;
    this.configPath = path.join(this.cache, 'run-config.json');
    this.checkpointPath = path.join(this.cache, 'checkpoint.json');
    this.pending = new Set();
    this.failures = [];
    this.waitingWorkers = [];
    this.activeWorkers = 0;
    this.stopping = false;
    this.fatal = null;
  }

  log(event, fields = {}) {
    const value = { time: now(), event, ...fields };
    fs.appendFileSync(path.join(this.cache, 'run-events.jsonl'), JSON.stringify(value) + '\n');
    console.log(JSON.stringify(value));
  }

  count() { return Object.keys(this.state.completed).length; }

  save() {
    this.state.updatedAt = now();
    this.state.completedCount = this.count();
    atomicJson(this.checkpointPath, this.state);
  }

  checkSpace() {
    requireSpace(this.cache, 512 * 1024 ** 2);
    return requireSpace(this.output, 24 * 1024 ** 2);
  }

  assertRunning() {
    if (this.stopping) throw new Error('INTERRUPTED');
    if (this.fatal) throw this.fatal;
  }

  terminal(error) {
    return /SOURCE_DRIFT|DISK:|GEOMETRY:|Native ICC profile|run fingerprint/i.test(String(error));
  }

  python(args, { timeout = 180000, acceptedCodes = [0], inherit = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.python, args, {
        cwd: ROOT, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout?.on('data', data => { stdout = (stdout + data).slice(-100000); });
      child.stderr?.on('data', data => { stderr = (stderr + data).slice(-100000); });
      const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (!acceptedCodes.includes(code)) reject(new Error(`Python exit ${code}: ${stdout} ${stderr}`));
        else resolve({ code, stdout, stderr });
      });
    });
  }

  async waitReady(id, matte) {
    for (let index = 0; index < 200; index++) {
      this.assertRunning();
      const state = await this.safari.evaluate('return window.__miNoteCapture?.state');
      if (state?.ready && state.id === id && (!matte || state.matte === matte) && !state.loading && state.frontOpacity === '1') return;
      await delay(200);
    }
    throw new Error(`Card ${id} ${matte || ''} not ready`);
  }

  async prepareBrowser() {
    this.safari = new Safari();
    const serverInfo = await this.safari.initialize();
    const primary = await this.safari.createTab(`${this.options.baseUrl}/scripts/mi-note-renderer/index.html?id=1430`);
    for (let index = 0; index < 200; index++) {
      this.assertRunning();
      if (await this.safari.evaluate('return Boolean(window.__miNoteCapture?.setCard)')) break;
      if (index === 199) throw new Error('Harness unavailable');
      await delay(100);
    }
    const auxiliary = await this.safari.createTab('about:blank');
    atomicJson(path.join(this.cache, 'session.json'), { primary, auxiliary, createdAt: now() });
    await this.safari.call('switch_tab', primary);
    await this.safari.call('set_viewport_size', { width: PRESET.windowWidth, height: PRESET.windowHeight });
    const geometry = await this.safari.evaluate('return {innerWidth,innerHeight,dpr:devicePixelRatio,visibility:document.visibilityState}');
    assertGeometry(geometry);
    await this.remount(460);
    await this.safari.evaluate('window.scrollTo(0,0);return true;');
    await this.safari.settle();
    const screenshot = path.join(this.cache, 'bootstrap-viewport.png');
    await this.safari.call('screenshot', { full_page: false, savePath: screenshot });
    const profile = JSON.parse((await this.python(['-c', VIEWPORT_PROFILE, screenshot])).stdout);
    const browser = await this.safari.evaluate('return navigator.userAgent');
    const driver = execFileSync('/usr/bin/safaridriver', ['--version'], { encoding: 'utf8' }).trim();
    this.log('browser-ready', { ...geometry, browser, driver, profile });
    return { profile, browser, driver, serverInfo };
  }

  initialize(environment) {
    const preflight = readJson(path.join(this.cache, 'assets-preflight.current.json'));
    const current = {
      sourceHashes: currentSourceHashes(), settings: { ...PRESET, browser: environment.browser, safariDriver: environment.driver },
      assetFingerprint: assetFingerprint(preflight), expectedIccSha256: environment.profile.sha256,
      runtime: this.options.runtime,
    };
    if (this.options.resume) {
      this.config = readJson(this.configPath);
      assertRun(this.config, current);
      this.state = readJson(this.checkpointPath);
    } else {
      this.config = {
        schemaVersion: 1, createdAt: now(), ...current, runFingerprint: runFingerprint(current),
        ids: CARD_IDS, controlIds: CONTROL_IDS, output: this.output, cache: this.cache,
        assetPreflight: path.join(this.cache, 'assets-preflight.json'),
        verification: 'Full per-card QA; repeated 20 controls and 460 every 100 completed cards',
        safariServer: environment.serverInfo, nativeIcc: environment.profile,
      };
      atomicJson(this.configPath, this.config);
      atomicJson(this.config.assetPreflight, preflight);
      this.state = newCheckpoint(this.config.runFingerprint);
    }
    for (const directory of ['qa', 'thumbnails', 'controls']) fs.mkdirSync(path.join(this.output, directory), { recursive: true });
    for (const directory of ['attempts', 'controls']) fs.mkdirSync(path.join(this.cache, directory), { recursive: true });
    const repairs = verifyCompleted(this.state, this.config, this.output, this.cache);
    atomicJson(path.join(this.output, 'capture-config.json'), this.config);
    atomicJson(path.join(this.output, 'assets-preflight.json'), readJson(this.config.assetPreflight));
    this.state.invocations ??= [];
    this.state.invocations.push({ at: now(), pid: process.pid, verifiedCompleted: this.count(), runtime: this.options.runtime });
    this.save();
    this.log('initialized', { completed: this.count(), repairs, runFingerprint: this.config.runFingerprint });
  }

  async remount(id) {
    const other = id === 1430 ? 1 : 1430;
    await this.safari.evaluate(`window.__miNoteCapture.setCard(${other});window.__miNoteCapture.setMatte('white');return true;`);
    await this.waitReady(other, 'white');
    await this.safari.settle();
  }

  async captureCard(id, raw, forceRemount = false) {
    this.assertRunning();
    assertSources(this.config);
    this.checkSpace();
    fs.mkdirSync(raw, { recursive: true });
    if (forceRemount) await this.remount(id);
    await this.safari.evaluate(`window.__miNoteCapture.setCard(${id});return true;`);
    for (const matte of ['white', 'black']) {
      await this.safari.evaluate(`window.__miNoteCapture.setMatte('${matte}');return true;`);
      await this.waitReady(id, matte);
      await this.safari.evaluate("const z=2000/(360*devicePixelRatio);const frame=document.getElementById('frame');frame.style.zoom=String(z);frame.style.left=(64/(devicePixelRatio*z))+'px';frame.style.top=(64/(devicePixelRatio*z))+'px';document.getElementById('root').style.minHeight=(2936/devicePixelRatio)+'px';return true;");
      let accepted = false;
      for (let paintAttempt = 1; paintAttempt <= PRESET.pairReadinessAttempts; paintAttempt++) {
        const tiles = [];
        for (const [index, scroll] of ['window.scrollTo(0,0)', 'window.scrollTo(0,document.documentElement.scrollHeight)'].entries()) {
          this.assertRunning();
          await this.safari.evaluate(`${scroll};return true;`);
          await this.safari.settle();
          const snapshot = await this.safari.evaluate(SNAPSHOT);
          assertGeometry(snapshot);
          if (Math.abs(snapshot.cardRect.width * snapshot.dpr - 2000) > .05 || Math.abs(snapshot.cardRect.height * snapshot.dpr - 2800) > .05) {
            throw new Error(`GEOMETRY: card ${id} ${JSON.stringify(snapshot.cardRect)}`);
          }
          if (snapshot.scrollY !== (index ? 488 : 0) || snapshot.visualViewport.pageTop !== (index ? 488 : 0) ||
              Math.abs(-snapshot.cardRect.y * snapshot.dpr - (index ? 1156 : -64)) > .05) {
            throw new Error(`GEOMETRY: non-integer scroll placement for ${id}`);
          }
          if (snapshot.id !== id || snapshot.matte !== matte || snapshot.actualEffect.opacity !== '0.99' || snapshot.actualEffect.shadow !== 'none') {
            throw new Error(`Pose/readiness mismatch for ${id}`);
          }
          const file = path.join(raw, `${id}-${matte}-${index}.png`);
          await this.safari.call('screenshot', { full_page: false, savePath: file });
          tiles.push({ path: file, ...snapshot });
        }
        const metadata = path.join(raw, `${id}-${matte}.json`);
        atomicJson(metadata, { id, matte, width: 2000, height: 2800, browserGutterPixels: 64, paintAttempt,
          method: 'Safari native MCP viewport compositor PNG, overlapping vertical tiles', tiles });
        const response = await this.python([path.join(TOOL_DIRECTORY, 'check_pair.py'), '--metadata', metadata,
          '--expected-icc', this.config.expectedIccSha256], { timeout: 30000, acceptedCodes: [0, 2] });
        const check = JSON.parse(response.stdout);
        if (check.passed) { accepted = true; break; }
        atomicJson(path.join(raw, `${id}-${matte}-unsettled-${paintAttempt}.json`), {
          id, matte, paintAttempt, check, rawRetained: false,
          captures: tiles.map(tile => ({ file: path.basename(tile.path), sha256: fileHash(tile.path), bytes: fs.statSync(tile.path).size })),
        });
        this.log('waiting-for-paint', { id, matte, paintAttempt });
        await delay(100);
      }
      if (!accepted) throw new Error(`Viewport pair did not stabilize for ${id} ${matte}`);
    }
    assertSources(this.config);
  }

  makeJob(id, controlLabel = null) {
    const key = controlLabel ? `control:${controlLabel}` : String(id);
    const attempt = (this.state.attempts[key] || 0) + 1;
    this.state.attempts[key] = attempt;
    this.save();
    const directory = path.join(this.cache, controlLabel ? 'controls' : 'attempts', controlLabel || String(id), `attempt-${attempt}`);
    return { id, attempt, controlLabel, directory, raw: path.join(directory, 'raw'), stage: path.join(directory, 'stage') };
  }

  async finalize(job, baseline = null) {
    if (this.activeWorkers >= 2) await new Promise(resolve => this.waitingWorkers.push(resolve));
    this.activeWorkers++;
    try {
      const args = [path.join(TOOL_DIRECTORY, 'finalize_worker.py'), '--id', String(job.id), '--raw', job.raw,
        '--stage', job.stage, '--fingerprint', this.config.runFingerprint, '--expected-icc', this.config.expectedIccSha256];
      if (baseline) args.push('--compare-with', baseline);
      const result = await this.python(args);
      fs.writeFileSync(path.join(job.directory, 'worker.log'), result.stdout + result.stderr);
      return readJson(path.join(job.stage, 'result.json'));
    } finally {
      this.activeWorkers--;
      this.waitingWorkers.shift()?.();
    }
  }

  commit(job, result) {
    assertSources(this.config);
    this.checkSpace();
    if (!result.qaPassed || result.id !== job.id || result.runFingerprint !== this.config.runFingerprint || result.iccSha256 !== this.config.expectedIccSha256) {
      throw new Error(`Invalid worker result ${job.id}`);
    }
    const source = path.join(job.stage, `${job.id}.png`);
    if (fileHash(source) !== result.fileSha256) throw new Error(`Staged hash mismatch ${job.id}`);
    moveDurably(source, path.join(this.output, `${job.id}.png`));
    const retained = CONTROL_IDS.includes(job.id);
    result.rawRetained = retained;
    result.rawDirectory = retained ? job.raw : null;
    const qa = path.join(this.output, 'qa', `${job.id}.json`);
    const thumbnail = path.join(this.output, 'thumbnails', `${job.id}.png`);
    atomicJson(qa, result);
    moveDurably(path.join(job.stage, 'thumb.png'), thumbnail);
    this.state.completed[job.id] = {
      id: job.id, fileSha256: result.fileSha256, decodedRgbaSha256: result.decodedRgbaSha256,
      iccSha256: result.iccSha256, bytes: result.bytes, completedAt: now(), report: `qa/${job.id}.json`,
      qaSha256: fileHash(qa), thumbnailSha256: fileHash(thumbnail),
    };
    if (!this.state.commitOrder.includes(job.id)) this.state.commitOrder.push(job.id);
    this.save();
    if (!retained) {
      const directory = fs.realpathSync(job.directory);
      const attempts = fs.realpathSync(path.join(this.cache, 'attempts')) + path.sep;
      if (!directory.startsWith(attempts)) throw new Error(`Unsafe scratch cleanup: ${directory}`);
      fs.rmSync(directory, { recursive: true });
    }
    if (this.count() <= 20 || this.count() % 10 === 0) this.log('committed', { id: job.id, completed: this.count() });
  }

  recordFailure(job, error) {
    const record = { time: now(), id: job.id, controlLabel: job.controlLabel, attempt: job.attempt, directory: job.directory, error: String(error) };
    this.state.failures.push(record);
    atomicJson(path.join(job.directory, 'capture-error.json'), record);
    this.save();
    this.log('attempt-failed', record);
  }

  async retryMaster(id) {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.assertRunning();
      const job = this.makeJob(id);
      try {
        await this.captureCard(id, job.raw, true);
        this.commit(job, await this.finalize(job));
        return;
      } catch (error) {
        this.recordFailure(job, error);
        if (this.terminal(error) || this.stopping) throw error;
        if (attempt === 1) throw new Error(`Card ${id} exhausted retries: ${error}`);
      }
    }
  }

  enqueue(job) {
    const task = this.finalize(job).then(result => this.commit(job, result)).catch(error => {
      this.recordFailure(job, error);
      this.failures.push({ id: job.id, error });
      if (this.terminal(error)) this.fatal = error;
    }).finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  async drain() { await Promise.all([...this.pending]); }

  async recoverFailures() {
    if (!this.failures.length) return;
    await this.drain();
    this.assertRunning();
    while (this.failures.length) {
      const failure = this.failures.shift();
      if (this.terminal(failure.error)) throw failure.error;
      await this.retryMaster(failure.id);
    }
  }

  async renderIds(ids) {
    for (const id of ids) {
      if (this.state.completed[id]) continue;
      this.assertRunning();
      await this.recoverFailures();
      while (this.pending.size >= 4) {
        await Promise.race(this.pending);
        await this.recoverFailures();
        this.assertRunning();
      }
      const job = this.makeJob(id);
      try {
        await this.captureCard(id, job.raw);
        this.enqueue(job);
      } catch (error) {
        this.recordFailure(job, error);
        await this.drain();
        if (this.terminal(error) || this.stopping) throw error;
        await this.retryMaster(id);
      }
    }
    await this.drain();
    await this.recoverFailures();
  }

  async control(id, label) {
    const prior = this.state.controls.find(record => record.label === label && record.passed);
    if (prior) {
      try {
        const report = readJson(path.join(this.output, prior.report));
        if (report.qaPassed && report.decodedRgbaSha256 === this.state.completed[id]?.decodedRgbaSha256 &&
            report.iccSha256 === this.state.completed[id]?.iccSha256 && report.runFingerprint === this.config.runFingerprint &&
            report.comparison?.decodedRgbaEqual && report.comparison?.iccBytesEqual) return false;
      } catch {}
      this.state.controls = this.state.controls.filter(record => record.label !== label);
      this.save();
    }
    if (!this.state.completed[id]) throw new Error(`Control ${id} has no verified master`);
    const baseline = path.join(this.output, `${id}.png`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = this.makeJob(id, label);
      try {
        await this.captureCard(id, job.raw, attempt > 0);
        const result = await this.finalize(job, baseline);
        if (!result.comparison?.decodedRgbaEqual || !result.comparison?.iccBytesEqual) throw new Error(`Control comparison failed ${id}`);
        atomicJson(path.join(this.output, 'controls', `${label}.json`), { ...result, label, baselineFile: baseline, passed: true });
        this.state.controls.push({ label, id, passed: true, completedAt: now(), completedCountAtCapture: this.count(),
          report: `controls/${label}.json`, comparison: result.comparison, runFingerprint: this.config.runFingerprint });
        this.save();
        this.log('control-passed', { id, label, completed: this.count() });
        return true;
      } catch (error) {
        this.recordFailure(job, error);
        if (this.terminal(error) || this.stopping) throw error;
        if (attempt === 2) throw new Error(`CONTROL_DRIFT: ${label}: ${error}`);
      }
    }
  }

  invalidateSinceLastControl() {
    const ids = this.state.commitOrder.slice(this.state.lastControlCount);
    const quarantine = path.join(this.cache, 'quarantine', `control-drift-${Date.now()}`);
    fs.mkdirSync(quarantine, { recursive: true });
    for (const id of ids) {
      for (const [name, file] of [['master', path.join(this.output, `${id}.png`)], ['qa', path.join(this.output, 'qa', `${id}.json`)], ['thumbnail', path.join(this.output, 'thumbnails', `${id}.png`)]]) {
        if (fs.existsSync(file)) moveDurably(file, path.join(quarantine, `${id}-${name}${path.extname(file)}`));
      }
      delete this.state.completed[id];
    }
    this.state.commitOrder = this.state.commitOrder.slice(0, this.state.lastControlCount);
    this.state.finalControlsComplete = false;
    for (const control of this.state.controls.filter(record => record.label.startsWith('end-'))) {
      const file = path.join(this.output, control.report);
      if (fs.existsSync(file)) moveDurably(file, path.join(quarantine, `${control.label}.json`));
    }
    this.state.controls = this.state.controls.filter(record => !record.label.startsWith('end-'));
    this.save();
    this.log('invalidated-after-control', { ids, quarantine });
  }

  async guardedControl(id, label) {
    try { return await this.control(id, label); }
    catch (error) {
      if (String(error).includes('CONTROL_DRIFT')) this.invalidateSinceLastControl();
      throw error;
    }
  }

  stopAtCheckpoint() {
    this.state.status = 'stopped';
    this.state.stopReason = 'Planned checkpoint stop';
    this.save();
    this.log('checkpoint-stop', { completed: this.count() });
  }

  async renderCollection() {
    const previouslyComplete = this.count();
    this.state.status = 'calibrating';
    this.save();
    if (previouslyComplete) {
      const label = Date.now();
      for (const id of CONTROL_IDS.filter(id => this.state.completed[id])) await this.guardedControl(id, `resume-${label}-${id}`);
      this.log('resume-verified', { completed: this.count() });
    }
    if (!this.state.completed[460]) await this.renderIds([460]);
    await this.guardedControl(460, 'startup-460');
    const limit = this.options.stopAfterStartup ? 20 : this.options.stopAfter;
    const startup = CONTROL_IDS.filter(id => !this.state.completed[id]);
    await this.renderIds(startup.slice(0, Math.max(0, limit - this.count())));
    if (CONTROL_IDS.every(id => this.state.completed[id])) {
      this.state.startupControlsComplete = true;
      this.state.lastControlCount = Math.max(this.state.lastControlCount, 20);
      this.save();
    }
    if (this.count() >= limit && this.count() < 1430) { this.stopAtCheckpoint(); return; }
    if (!this.state.startupControlsComplete) throw new Error('Startup control set incomplete');
    for (let boundary = 100; boundary <= this.count(); boundary += 100) {
      if (await this.guardedControl(460, `after-${String(boundary).padStart(4, '0')}`)) {
        this.state.lastControlCount = this.count();
        this.save();
      }
    }
    this.state.status = 'capturing';
    this.save();
    while (this.count() < 1430) {
      this.assertRunning();
      const boundary = Math.min(1430, limit, (Math.floor(this.count() / 100) + 1) * 100);
      const missing = CARD_IDS.filter(id => !this.state.completed[id]).slice(0, boundary - this.count());
      await this.renderIds(missing);
      if (this.count() % 100 === 0) {
        await this.guardedControl(460, `after-${String(this.count()).padStart(4, '0')}`);
        this.state.lastControlCount = this.count();
        this.save();
      }
      if (this.count() >= limit && this.count() < 1430) { this.stopAtCheckpoint(); return; }
    }
    this.state.status = 'final-controls';
    this.save();
    for (const id of CONTROL_IDS) await this.guardedControl(id, `end-${id}`);
    const finalAssets = path.join(this.cache, 'assets-preflight-final.json');
    await this.python([path.join(TOOL_DIRECTORY, 'preflight_assets.py'), '--output', finalAssets], { timeout: 600000, inherit: true });
    this.assertRunning();
    assertSources(this.config);
    if (assetFingerprint(readJson(finalAssets)) !== this.config.assetFingerprint) throw new Error('SOURCE_DRIFT: source assets changed during capture');
    atomicJson(path.join(this.output, 'assets-preflight-final.json'), readJson(finalAssets));
    this.state.finalControlsComplete = true;
    this.state.status = 'captured';
    this.state.finishedAt = now();
    this.save();
    this.log('capture-complete', { completed: this.count(), controls: this.state.controls.length });
  }

  async run() {
    fs.mkdirSync(this.cache, { recursive: true });
    fs.mkdirSync(this.output, { recursive: true });
    this.checkSpace();
    const stop = () => { this.stopping = true; this.log('stop-requested'); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const awake = spawn('/usr/bin/caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' });
    awake.on('error', error => { this.fatal = error; });
    try {
      const environment = await this.prepareBrowser();
      this.assertRunning();
      this.initialize(environment);
      await this.renderCollection();
      return this.state;
    } catch (error) {
      await this.drain();
      if (this.state) {
        this.state.status = 'stopped';
        this.state.stopReason = String(error);
        this.save();
      }
      this.log('stopped', { error: String(error), completed: this.state ? this.count() : 0 });
      throw error;
    } finally {
      const tabs = await this.safari?.close();
      awake.kill();
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      const cleanup = { completedAt: now(), tabs: tabs || [], automationSettingChangedByRunner: false,
        automationReminder: 'Restore Safari remote automation to its previous setting when finished.' };
      atomicJson(path.join(this.cache, 'cleanup.json'), cleanup);
      if (this.state) {
        atomicJson(path.join(this.output, 'capture-session-summary.json'), {
          schemaVersion: 1, runFingerprint: this.config.runFingerprint, status: this.state.status,
          count: this.count(), startedAt: this.state.startedAt, finishedAt: this.state.finishedAt,
          successfulRepeatChecks: this.state.controls.length, repeatedControlIds: CONTROL_IDS,
          verificationCoverage: 'Every card receives capture and reconstruction QA. Only the 20 control IDs are repeated.',
          failures: this.state.failures, invocations: this.state.invocations, resumeVerification: this.state.resumeVerification, cleanup,
        });
      }
      console.log(cleanup.automationReminder);
    }
  }
}

export async function capture(options) {
  if (process.platform !== 'darwin') throw new Error('Native Safari capture requires macOS. Publication and offline tests can run separately.');
  return new CaptureRun({ stopAfter: Infinity, stopAfterStartup: false, ...options }).run();
}
