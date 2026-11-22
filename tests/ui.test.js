var assert = require('assert');
require('../src/cpu.js');
require('../src/asm.js');
require('../src/snake_asm.js');
var TC = require('../src/ui.js');   // must load without a DOM
var UI = TC.UI;

// fade: full at t0, ease-out decay, zero at/after duration and for "never"
assert.strictEqual(UI.fade(1000, 1000, 300), 1);
assert.ok(UI.fade(1150, 1000, 300) < 0.5);           // ease-out: past half-way early
assert.ok(UI.fade(1150, 1000, 300) > 0);
assert.strictEqual(UI.fade(1300, 1000, 300), 0);
assert.strictEqual(UI.fade(5000, 0, 300), 0);
assert.strictEqual(UI.hex(0xA, 2), '0A');

function session(src) {
  var s = new UI.Session(new TC.CPU());
  assert.deepStrictEqual(s.load(src).errors, []);
  s.running = true;
  return s;
}

// Fractional budget: 1 ips at 60 fps executes exactly 1 instruction per second
var s = session('loop: NOP\nJMP loop');
s.ips = 1;
var total = 0;
for (var f = 0; f < 60; f++) total += s.frame(1000 / 60, f * 16.7 + 1);
assert.strictEqual(total, 1);
s.ips = 5; total = 0;
for (f = 0; f < 120; f++) total += s.frame(1000 / 60, f * 16.7 + 1);
assert.strictEqual(total, 10);
// big dt is clamped (hidden tab): 100ms max
s.ips = 1000; assert.strictEqual(s.frame(5000, 1), 100);
// not running -> nothing
s.running = false; assert.strictEqual(s.frame(16, 1), 0);

// Visual bookkeeping: reads/writes/register changes get timestamps
s = session('LDI R0, 0x40\nLDI R1, 7\nST [R0], R1\nLD R2, [R0]\nLDI R1, 7\nHALT');
s.ips = 60;
s.frame(1000, 500);                                    // runs everything (60 budget)
assert.strictEqual(s.lastWrite[0x40], 500);
assert.strictEqual(s.lastRead[0x40], 500);
assert.strictEqual(s.regT[0], 500); assert.strictEqual(s.regT[2], 500);
assert.ok(!s.running, 'halt stops the run loop');
// re-loading the same value is not a change -> no flash
s = session('LDI R1, 7\nLDI R1, 7\nHALT');
s.ips = 1000; s.frame(1, 10); assert.strictEqual(s.regT[1], 10);
s.frame(1, 20); assert.strictEqual(s.regT[1], 10);

// Only the last 64 traces of a frame flash registers; memory marks always
s = session('LDI R3, 1\n' + new Array(200).join('NOP\n') + 'HALT');
s.ips = 100000; s.frame(16, 42);
assert.strictEqual(s.regT[3], 0, 'early trace skipped for register visuals');

// Snake runs headless inside the session at the default speed, and paints the screen
s = session(TC.samples.snake);
for (f = 0; f < 120; f++) s.frame(1000 / 60, 1 + f * 16.7);  // 2 seconds
assert.ok(Math.abs(s.cpu.cycle - 2 * s.ips) <= s.ips / 50, 'cycles ' + s.cpu.cycle);
var lit = 0; for (var i = 0; i < 256; i++) if (s.cpu.vram[i]) lit++;
assert.ok(lit >= 4);
assert.ok(s.map[s.cpu.pc] > 0, 'pc maps to a source line');
assert.strictEqual(s.cpu.fault, null);

// ---------- Phase 6: controls logic ----------
// speed slider: log scale 1..200,000, round-trips
assert.strictEqual(UI.sliderToIps(0), 1);
assert.strictEqual(UI.sliderToIps(1000), 200000);
var mid = UI.sliderToIps(500); assert.ok(mid > 400 && mid < 500, 'log midpoint ' + mid);
[1, 10, 2000, 40000, 200000].forEach(function (ips) {
  var back = UI.sliderToIps(UI.ipsToSlider(ips));
  assert.ok(Math.abs(back - ips) / ips < 0.02, ips + ' -> ' + back);
});

// breakpoints: only on instruction lines; run loop pauses there; Run steps past it
s = session('; comment\nLDI R0, 0\nloop: ADDI R0, 1\nJMP loop');
assert.strictEqual(s.toggleBp(1), false, 'comment line refused');
assert.strictEqual(s.toggleBp(3), true);
s.ips = 1000;
s.frame(100, 1);
assert.strictEqual(s.running, false);
assert.strictEqual(s.hitLine, 3);
assert.strictEqual(s.cpu.regs[0], 0, 'paused before executing line 3');
s.run(); s.frame(100, 2);
assert.strictEqual(s.hitLine, 3); assert.strictEqual(s.cpu.regs[0], 1, 'one loop per Run');
s.toggleBp(3);                                     // remove it: runs freely
s.run(); s.frame(100, 3); assert.ok(s.running); assert.ok(s.cpu.regs[0] > 10);

// step: pauses, executes exactly one instruction, ignores breakpoints, flashes regs
s = session('LDI R0, 5\nLDI R1, 6\nHALT');
s.toggleBp(1);
var tr = s.stepOnce(77);
assert.strictEqual(s.running, false); assert.strictEqual(s.cpu.regs[0], 5); assert.strictEqual(s.regT[0], 77);
s.stepOnce(78); s.stepOnce(79);
assert.ok(s.cpu.halted); assert.strictEqual(s.stepOnce(80), null, 'no step when halted');
s.run(); assert.strictEqual(s.running, false, 'cannot Run a halted CPU');
s.reset(); assert.ok(!s.cpu.halted); assert.strictEqual(s.cpu.pc, 0); assert.strictEqual(s.regT[0], 0);
s.run(); s.frame(1000, 90); assert.strictEqual(s.cpu.regs[1], 6, 'program kept across reset');

// reassemble: errors leave the running program untouched; success swaps it
s = session('loop: ADDI R2, 1\nJMP loop');
var before = Array.from(s.cpu.prog.slice(0, 2));
var res = s.load('LDI R0, 1\nBOGUS\nJMP nowhere');
assert.deepStrictEqual(res.errors.map(function (e) { return e.line; }), [2, 3]);
assert.deepStrictEqual(Array.from(s.cpu.prog.slice(0, 2)), before);
res = s.load('LDI R5, 9\nHALT');
assert.deepStrictEqual(res.errors, []); s.run(); s.frame(100, 1);
assert.strictEqual(s.cpu.regs[5], 9);

// editing STEP_FRAMES and reassembling changes the game speed
function stepPeriod(text) {
  var ss = session(text), c = ss.cpu, S = TC.assemble(text).symbols, starts = [];
  for (var k = 0; k < 200000 && starts.length < 3; k++) { if (c.pc === S.GAME_STEP) starts.push(c.cycle); c.run(1); }
  return starts[2] - starts[1];
}
var p4 = stepPeriod(TC.samples.snake);
var p8 = stepPeriod(TC.samples.snake.replace(/\.equ STEP_FRAMES, 4/, '.equ STEP_FRAMES, 8'));
assert.ok(Math.abs(p4 - 8000) < 200 && Math.abs(p8 - 16000) < 200, p4 + ' / ' + p8);

// ---------- UI improvements ----------
// memory cells hold for the ~400 ms window (much brighter than the register curve mid-way)
assert.strictEqual(UI.memFade(100, 100, 400), 1);
assert.ok(UI.memFade(300, 100, 400) >= 0.75, 'still lit half-way');
assert.strictEqual(UI.memFade(500, 100, 400), 0);

// instruction trail: last 8, oldest first, newest last; cleared on reset
s = session('LDI R0, 1\nLDI R1, 2\nloop: ADDI R0, 1\nJMP loop');
s.stepOnce(1); s.stepOnce(2);
assert.deepStrictEqual(s.trail().map(function (e) { return e.pc; }), [0, 1]);
for (i = 0; i < 20; i++) s.stepOnce(3 + i);
var tl = s.trail();
assert.strictEqual(tl.length, 8);
assert.strictEqual(tl[7].pc, s.cpu.trace.pc, 'newest last');
assert.strictEqual(TC.disassemble(tl[7].word), s.cpu.pc === 2 ? 'JMP 2' : 'ADDI R0, 1');
s.reset(); assert.strictEqual(s.trail().length, 0);
// at high speed the trail still holds the real last 8
s = session('loop: ADDI R0, 1\nJMP loop'); s.ips = 100000; s.frame(16, 1);
assert.strictEqual(s.trail().length, 8);

// plain-English description of what just ran
s = session('.equ HEAD_I, 0xA0\nLDI R0, 7\nSTA [HEAD_I], R0\nLDA R1, [HEAD_I]\nCMPI R1, 7\nJZ done\nNOP\ndone: LDI R2, 1\nVST [R2], R2\nHALT');
function says() { return UI.describe(s.cpu.trace, s.cpu.pc, s.info); }
s.stepOnce(1); assert.strictEqual(says(), 'Puts 7 into R0. Changed: R0 00 → 07.');
s.stepOnce(2); assert.strictEqual(says(), 'Stores R0 into RAM[0xA0] (HEAD_I). Changed: RAM[0xA0] (HEAD_I) = 07.');
s.stepOnce(3); assert.strictEqual(says(), 'Loads R1 from RAM[0xA0] (HEAD_I). Changed: R1 00 → 07.');
s.stepOnce(4); assert.strictEqual(says(), 'Compares R1 with 7 (sets flags only). Changed: flags none → Z.');
s.stepOnce(5); assert.strictEqual(says(), 'Jumps to done if the result was zero: jumped. Nothing changed.');
s.stepOnce(6); s.stepOnce(7);
assert.strictEqual(says(), 'Paints a screen pixel from R2 at the position in R2. Changed: pixel (1,0) = green.');

console.log('ui tests ok');
