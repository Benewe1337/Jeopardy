// Lädt js/common.js in einer Node-Sandbox mit einem minimalen Browser-Ersatz
// (localStorage, document), damit die reine Spiellogik ohne Browser testbar ist.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../../js/common.js'), 'utf8');

const STATS = fs.readFileSync(path.join(__dirname, '../../js/stats.js'), 'utf8');
const FINALE = fs.readFileSync(path.join(__dirname, '../../js/finale.js'), 'utf8');
const DD = fs.readFileSync(path.join(__dirname, '../../js/dd.js'), 'utf8');

function loadCommon() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const document = { documentElement: { dataset: {} } };
  const window = { localStorage, document };
  const context = { window, crypto: require('crypto').webcrypto, localStorage, document, console, URL, Date, Math, JSON, btoa, atob, escape, unescape };
  vm.createContext(context);
  vm.runInContext(SRC, context, { filename: 'common.js' });
  vm.runInContext(FINALE, context, { filename: 'finale.js' });
  vm.runInContext(DD, context, { filename: 'dd.js' });
  vm.runInContext(STATS, context, { filename: 'stats.js' });
  return { J: window.J, localStorage, document };
}

module.exports = { loadCommon };
