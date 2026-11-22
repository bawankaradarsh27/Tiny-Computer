var assert = require('assert');
var fs = require('fs');
var path = require('path');
require('../src/cpu.js');
require('../src/asm.js');
var TC = require('../src/counter_asm.js');

var onDisk = fs.readFileSync(path.join(__dirname, '..', 'games', 'counter.asm'), 'utf8').replace(/\r\n/g, '\n');
assert.strictEqual(TC.samples.counter, onDisk, 'src/counter_asm.js is stale: run node tools/embed.js');

var asm = TC.assemble(TC.samples.counter);
assert.deepStrictEqual(asm.errors, []);
var S = asm.symbols;

var c = new TC.CPU(); c.load(asm.words);
function barLength() { var n = 0; for (var x = 0; x < 16; x++) if (c.vram[S.ROW + x] === 1) n++; return n; }
function otherPixels() { var n = 0; for (var i = 0; i < 256; i++) if (c.vram[i] && (i < S.ROW || i >= S.ROW + 16)) n++; return n; }
function untilCount(n) {
  for (var i = 0; i < 2000000 && c.ram[S.COUNT] !== n; i++) c.run(1);
  assert.strictEqual(c.ram[S.COUNT], n);
  c.run(1);                                       // the next instruction stores SCORE
}

untilCount(1);
assert.strictEqual(barLength(), 1); assert.strictEqual(c.ram[0xF3], 1);
untilCount(3);
assert.strictEqual(barLength(), 3); assert.strictEqual(c.ram[0xF3], 3);
// counts are paced by FRAME: TICKS frames (2000 instructions each) per count
var c0 = c.cycle; untilCount(4);
assert.ok(Math.abs(c.cycle - c0 - S.TICKS * 2000) < 100, 'period ' + (c.cycle - c0));
untilCount(16);
assert.strictEqual(barLength(), 16, 'full bar');
untilCount(17);
assert.strictEqual(barLength(), 1, 'bar restarts');
assert.strictEqual(otherPixels(), 0, 'only row 8 is drawn');
untilCount(255); untilCount(0);                  // wraps at 256 without faulting
assert.strictEqual(c.fault, null); assert.strictEqual(c.rsp, 0, 'no return-stack leak');

console.log('counter tests ok');
