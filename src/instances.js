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

module.exports = { read, register, unregister, alive, verify, FILE };
