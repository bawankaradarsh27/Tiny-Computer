// Shared helpers for headless game tests (not a test file itself).
var assert = require('assert');
var fs = require('fs');
var path = require('path');
require('../src/cpu.js');
var TC = require('../src/asm.js');

// Load games/<name>.asm via its generated src/<name>_asm.js, check it isn't stale, assemble.
function loadGame(name) {
  require('../src/' + name + '_asm.js');
  var onDisk = fs.readFileSync(path.join(__dirname, '..', 'games', name + '.asm'), 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(TC.samples[name], onDisk, 'src/' + name + '_asm.js is stale: run node tools/embed.js');
  var asm = TC.assemble(TC.samples[name]);
  assert.deepStrictEqual(asm.errors, []);
  assert.ok(asm.words.length < 400, name + ' is ' + asm.words.length + ' words');
  return asm;
}

function runUntil(c, pred, cap) {
  for (var i = 0; i < (cap || 200000); i++) { if (pred()) return true; c.run(1); if (c.halted) break; }
  return pred();
}

// New CPU running the game, stopped at its MAIN label after init.
function boot(asm) {
  var c = new TC.CPU(); c.load(asm.words);
  assert.ok(runUntil(c, function () { return c.pc === asm.symbols.MAIN && c.rsp === 0; }), 'reached main');
  return c;
}

// One full GAME_STEP: enter it, then run until it returns to main.
function step(c, asm) {
  assert.ok(runUntil(c, function () { return c.pc === asm.symbols.GAME_STEP; }), 'entered game_step');
  c.run(1);
  assert.ok(runUntil(c, function () { return c.rsp === 0; }, 100000), 'game_step returned');
}

function count(c, v) { var n = 0; for (var i = 0; i < 256; i++) if (c.vram[i] === v) n++; return n; }
function allRed(c) { return count(c, 2) === 256; }

module.exports = { TC: TC, loadGame: loadGame, runUntil: runUntil, boot: boot, step: step, count: count, allRed: allRed };
