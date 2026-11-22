var assert = require('assert');
var fs = require('fs');
var path = require('path');
require('../src/cpu.js');
require('../src/asm.js');
var TC = require('../src/snake_asm.js');

// The embedded copy must match games/snake.asm (run tools/embed.js after edits).
var onDisk = fs.readFileSync(path.join(__dirname, '..', 'games', 'snake.asm'), 'utf8').replace(/\r\n/g, '\n');
assert.strictEqual(TC.samples.snake, onDisk, 'src/snake_asm.js is stale: run node tools/embed.js');

var asm = TC.assemble(TC.samples.snake);
assert.deepStrictEqual(asm.errors, []);
assert.ok(asm.words.length < 300, 'program is ' + asm.words.length + ' words');
var S = asm.symbols;
var HEAD_I = S.HEAD_I, BODY = S.BODY;

function count(c, v) { var n = 0; for (var i = 0; i < 256; i++) if (c.vram[i] === v) n++; return n; }
function head(c) { return c.ram[BODY + c.ram[HEAD_I]]; }
function runUntil(c, pred, cap) {
  for (var i = 0; i < (cap || 200000); i++) { if (pred()) return true; c.run(1); if (c.halted) break; }
  return pred();
}
function boot() {
  var c = new TC.CPU(); c.load(asm.words);
  assert.ok(runUntil(c, function () { return c.pc === S.MAIN; }), 'reached main');
  return c;
}
// Run exactly one game step: until game_step is entered, then until it returns to main.
function step(c) {
  assert.ok(runUntil(c, function () { return c.pc === S.GAME_STEP; }), 'entered game_step');
  c.run(1);
  assert.ok(runUntil(c, function () { return c.rsp === 0; }, 50000), 'game_step returned');
}

// (a) initial screen: 3 body pixels + 1 food
var c = boot();
assert.strictEqual(count(c, 1), 3);
assert.strictEqual(count(c, 2), 1);
assert.strictEqual(head(c), 0x88);
assert.strictEqual(c.ram[0xF3], 0);
assert.strictEqual(c.fault, null);

// (b) moves right one cell per step, length stays 3
step(c);
assert.strictEqual(head(c), 0x89);
assert.strictEqual(c.vram[0x89], 1); assert.strictEqual(c.vram[0x86], 0);
assert.strictEqual(count(c, 1), 3);
step(c);
assert.strictEqual(head(c), 0x8A);
// steps are paced by FRAME: one step every STEP_FRAMES * 2000 instructions
var c0 = c.cycle; step(c);
assert.ok(Math.abs((c.cycle - c0) - S.STEP_FRAMES * 2000) < 200, 'step period ' + (c.cycle - c0));

// (c) turning works, reversal ignored
c.setKey(2); step(c);                  // down
assert.strictEqual(head(c), 0x9B);
c.setKey(1); step(c);                  // up = reversal of down: ignored
assert.strictEqual(head(c), 0xAB);
c.setKey(3); step(c);                  // left
assert.strictEqual(head(c), 0xAA);
c.setKey(4); step(c);                  // right = reversal of left: ignored
assert.strictEqual(head(c), 0xA9);
assert.strictEqual(count(c, 1), 3);

// (d) eating grows the body and raises SCORE
c.vram[0xA8] = 2;                       // put food right in front of the head
var foodBefore = count(c, 2);
step(c);
assert.strictEqual(head(c), 0xA8);
assert.strictEqual(count(c, 1), 4);
assert.strictEqual(c.ram[0xF3], 1);
assert.strictEqual(count(c, 2), foodBefore); // eaten one, placed one
step(c);                                // next normal move keeps length 4
assert.strictEqual(count(c, 1), 4);

// (e) hitting the wall turns the screen red
c = boot();
for (var i = 0; i < 7; i++) step(c);   // x: 8 -> 15
assert.strictEqual(head(c) & 15, 15);
assert.ok(runUntil(c, function () { return count(c, 2) === 256; }, 100000), 'screen all red');
c.run(5000);                            // stays in game over without a key
assert.strictEqual(count(c, 2), 256);

// (f) a key press after game over restarts
c.ram[0xF3] = 7;
c.setKey(4);
assert.ok(runUntil(c, function () { return c.pc === S.MAIN && c.rsp === 0; }, 10000), 'back in main');
assert.strictEqual(count(c, 1), 3);
assert.strictEqual(count(c, 2), 1);
assert.strictEqual(c.ram[0xF3], 0);
step(c);
assert.strictEqual(head(c), 0x89);

// running into its own body ends the game
c = boot();
c.vram[0x89] = 1;                       // body cell right in front of the head
assert.ok(runUntil(c, function () { return count(c, 2) === 256; }, 100000), 'self-collision -> red');

// length cap: a 127-long snake that eats keeps length 127 (ring never overflows)
c = boot();
c.vram.fill(0);
for (i = 0; i < 127; i++) { c.ram[BODY + i] = 0x10 + i; c.vram[0x10 + i] = 1; } // cells 0x10..0x8E
c.ram[S.TAIL_I] = 0; c.ram[HEAD_I] = 126;              // head at 0x8E (y=8, x=14), moving right
c.vram[0x8F] = 2;                                       // food in front
c.ram[0xF3] = 0;
step(c);
assert.strictEqual(head(c), 0x8F);
assert.strictEqual(count(c, 1), 127, 'length capped at 127');
assert.strictEqual(c.ram[0xF3], 1);
assert.strictEqual(c.vram[0x10], 0, 'tail moved on');
assert.strictEqual(count(c, 2), 1, 'new food placed');
c.setKey(2); step(c);                                   // normal moves keep 127
assert.strictEqual(head(c), 0x9F); assert.strictEqual(count(c, 1), 127);
assert.strictEqual(c.fault, null);

// many games in a row don't leak the return stack
for (var g = 0; g < 20; g++) {
  c.run(2000);                          // let game_over reach its key-wait loop
  c.setKey(4);
  assert.ok(runUntil(c, function () { return c.pc === S.MAIN && c.rsp === 0; }, 10000), 'restart ' + g);
  c.vram[head(c) + 1] = 1;              // block the next cell -> dies on next step
  assert.ok(runUntil(c, function () { return count(c, 2) === 256; }, 100000), 'game ' + g + ' over');
}
assert.strictEqual(c.fault, null);
assert.ok(c.rsp <= 2, 'return stack depth ' + c.rsp);

console.log('snake tests ok (' + asm.words.length + ' words)');
