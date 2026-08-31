'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR_NAME = '.protoserve';
const LOCK_NAME = '.lock';
const VERSION = 1;
const LOCK_STALE_MS = 3000;  // a lock older than this belonged to a dead process
const LOCK_WAIT_MS = 500;    // never block the server longer than this
const LOCK_TRIES = 200;      // hard bound: the loop must always terminate

function relKey(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function empty() {
  return { version: VERSION, files: {} };
}

/** Block this process briefly without spinning the CPU. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, DIR_NAME);
    this.file = path.join(this.dir, 'comments.json');
    this.shotDir = path.join(this.dir, 'screenshots');
  }

  /**
   * Read the store. A missing file is normal and yields an empty store.
   * Unreadable JSON is quarantined rather than silently discarded — otherwise
   * the next write would overwrite recoverable comments with nothing.
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return empty();
      throw e; // permissions, EMFILE — never pretend the store is empty
    }
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || typeof data.files !== 'object' || !data.files) {
        throw new Error('unexpected shape');
      }
      return data;
    } catch (e) {
      this.quarantine();
      return empty();
    }
  }

  // Move the damaged file aside rather than copying it, so a later read sees a
  // clean slate instead of quarantining the same file over and over.
  quarantine() {
    try {
      const stamp = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
      const dest = path.join(this.dir, 'comments.corrupt-' + stamp + '.json');
      fs.renameSync(this.file, dest);
      process.emitWarning(
        'protoserve: comments.json was unreadable and has been preserved at ' + dest
      );
    } catch { /* nothing more we can do */ }
  }

  save(data) {
    this.assertLockHeld();
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
    this.ensureIgnore();
  }

  ensureIgnore() {
    const gi = path.join(this.dir, '.gitignore');
    if (!fs.existsSync(gi)) {
      try { fs.writeFileSync(gi, 'screenshots/\n*.tmp\n.lock/\n'); } catch { /* non-fatal */ }
    }
  }

  /** Refuse to write unless we still own the lock we took. */
  assertLockHeld() {
    if (!this._token) return; // an unlocked read-only save path does not exist today
    let owner = null;
    try { owner = fs.readFileSync(path.join(this.dir, LOCK_NAME, 'owner'), 'utf8'); } catch { owner = null; }
    if (owner !== this._token) {
      throw new Error('protoserve: lost the comment-store lock before writing; nothing was saved');
    }
  }

  /**
   * Every mutation is a read-modify-write of one JSON file, and the browser and
   * the CLI both write. Without this lock a comment saved in the page and a
   * `protoserve resolve` running at the same moment lose one of the two.
   *
   * The wait is short and bounded: this runs on the server's only thread, so it
   * must never spin, and it fails loudly rather than stealing a live lock.
   */
  withLock(fn) {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, LOCK_NAME);
    const token = process.pid + '-' + crypto.randomBytes(6).toString('hex');
    const deadline = Date.now() + LOCK_WAIT_MS;
    let held = false;

    for (let i = 0; i < LOCK_TRIES && !held; i++) {
      try {
        fs.mkdirSync(lock);
        held = true;
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Only ever break a lock old enough that its owner must be gone.
        let age = 0;
        try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = LOCK_STALE_MS + 1; }
        if (age > LOCK_STALE_MS) {
          try { fs.rmSync(lock, { recursive: true, force: true }); } catch (rmErr) {
            throw new Error('protoserve: cannot clear a stale lock at ' + lock + ' (' + rmErr.code + ')');
          }
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error('protoserve: another protoserve process is writing comments; try again');
        }
        sleepSync(10);
      }
    }
    if (!held) throw new Error('protoserve: could not acquire the comment-store lock');

    try { fs.writeFileSync(path.join(lock, 'owner'), token); } catch { /* best effort */ }
    this._token = token;
    try {
      return fn();
    } finally {
      this._token = null;
      try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* released anyway */ }
    }
  }

  bucket(data, key) {
    if (!data.files[key]) data.files[key] = { counter: 0, comments: [] };
    const b = data.files[key];
    if (!Array.isArray(b.comments)) b.comments = [];
    if (typeof b.counter !== 'number') b.counter = b.comments.length;
    return b;
  }

  list(key) {
    return this.bucket(this.load(), key).comments;
  }

  /** Ids must be unique across the whole store: screenshots share one folder. */
  newId(data) {
    const taken = new Set();
    for (const k of Object.keys(data.files)) {
      for (const c of data.files[k].comments || []) taken.add(c.id);
    }
    let id;
    do { id = crypto.randomBytes(4).toString('hex'); } while (taken.has(id));
    return id;
  }

  add(key, comment) {
    return this.withLock(() => {
      const data = this.load();
      const b = this.bucket(data, key);
      const c = Object.assign({}, comment);
      c.id = this.newId(data);
      if (c.parent_id) {
        c.number = null;
      } else {
        b.counter += 1;
        c.number = b.counter;
      }
      c.created_at = new Date().toISOString();
      c.resolved = false;
      b.comments.push(c);
      this.save(data);
      return c;
    });
  }

  restore(key, comment) {
    return this.withLock(() => {
      const data = this.load();
      const b = this.bucket(data, key);
      if (b.comments.some((c) => c.id === comment.id)) return comment;
      b.comments.push(comment);
      if (typeof comment.number === 'number' && comment.number > b.counter) b.counter = comment.number;
      this.save(data);
      return comment;
    });
  }

  update(key, id, patch) {
    return this.withLock(() => {
      const data = this.load();
      const b = this.bucket(data, key);
      const c = b.comments.find((x) => x.id === id);
      if (!c) return null;
      if (typeof patch.text === 'string') c.text = patch.text;
      if (typeof patch.resolved === 'boolean') {
        c.resolved = patch.resolved;
        c.resolved_at = patch.resolved ? new Date().toISOString() : null;
        for (const r of b.comments) if (r.parent_id === id) r.resolved = patch.resolved;
      }
      c.updated_at = new Date().toISOString();
      this.save(data);
      return c;
    });
  }

  remove(key, id) {
    const removed = this.withLock(() => {
      const data = this.load();
      const b = this.bucket(data, key);
      if (!b.comments.some((x) => x.id === id)) return null;
      const gone = b.comments.filter((c) => c.id === id || c.parent_id === id);
      b.comments = b.comments.filter((c) => c.id !== id && c.parent_id !== id);
      this.save(data);
      return gone;
    });
    if (removed) for (const c of removed) this.deleteShot(c);
    return removed;
  }

  /** Attach a screenshot to a comment. The file is only written if it has an owner. */
  attachShot(key, id, dataUrl) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    return this.withLock(() => {
      const data = this.load();
      const b = this.bucket(data, key);
      const c = b.comments.find((x) => x.id === id);
      if (!c) return null;
      fs.mkdirSync(this.shotDir, { recursive: true });
      const rel = 'screenshots/' + id + '.png';
      fs.writeFileSync(path.join(this.dir, rel), Buffer.from(m[1], 'base64'));
      c.screenshot = rel;
      this.save(data);
      return rel;
    });
  }

  deleteShot(comment) {
    const p = this.shotPath(comment);
    if (!p) return;
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }

  shotPath(comment) {
    if (!comment || !comment.screenshot) return null;
    const p = path.resolve(this.dir, comment.screenshot);
    // comments.json is editable by hand; a doctored path must not escape.
    if (p !== this.shotDir && !p.startsWith(this.shotDir + path.sep)) return null;
    return p;
  }
}

module.exports = { Store, relKey, DIR_NAME, LOCK_NAME };
