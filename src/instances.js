'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// A plain file, deliberately NOT a `.protoserve` directory: that name is what
// findRoot looks for when locating a prototype's comment store, and a folder in
// $HOME would make every lookup resolve to the home directory.
const FILE = path.join(os.homedir(), '.protoserve-state.json');

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM means it exists, owned by someone else
}

function read() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.filter((i) => i && typeof i.pid === 'number' && typeof i.port === 'number'
      && typeof i.root === 'string' && alive(i.pid));
  } catch { return []; }
}

function write(list) {
  try {
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, FILE);
  } catch { /* the registry is a convenience, never load-bearing */ }
}

function register(entry) {
  write(read().filter((i) => i.pid !== entry.pid).concat([entry]));
}

function unregister(pid) {
  write(read().filter((i) => i.pid !== pid));
}

/**
 * Confirm a registered pid really is this protoserve instance before signalling
 * it — pids get recycled, and a stale entry must never kill someone else's work.
 */
function verify(entry, timeout) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port: entry.port, path: '/__protoserve/ping',
      timeout: timeout || 700, headers: { Host: 'localhost:' + entry.port }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j && j.protoserve === true && j.pid === entry.pid);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/* Agents that are watching for sent comments. Kept apart from the server registry above: a
   listener is a `protoserve watch --sent` process, not a server, and the page only needs to know
   whether anyone is on the other end of the Send button. Same home-folder file convention, so it
   never lands in a project's git status. */
const LISTENERS = path.join(os.homedir(), '.protoserve-listeners.json');

function readListeners() {
  try {
    const list = JSON.parse(fs.readFileSync(LISTENERS, 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.filter((i) => i && typeof i.pid === 'number' && typeof i.root === 'string' && alive(i.pid));
  } catch { return []; }
}

function writeListeners(list) {
  try {
    const tmp = LISTENERS + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, LISTENERS);
  } catch { /* a convenience, never load-bearing */ }
}

function registerListener(entry) {
  writeListeners(readListeners().filter((i) => i.pid !== entry.pid).concat([entry]));
}

function unregisterListener(pid) {
  writeListeners(readListeners().filter((i) => i.pid !== pid));
}

/** How many live watchers would pick up a send for this file. A watcher with no file takes any. */
function listenersFor(root, file) {
  return readListeners().filter((i) => i.root === root && (!i.file || i.file === file)).length;
}

module.exports = {
  read, register, unregister, alive, verify, FILE,
  registerListener, unregisterListener, listenersFor
};
