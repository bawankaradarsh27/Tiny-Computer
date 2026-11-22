var assert = require('assert');
var TC = require('../src/cpu.js');

function R(op, a, b) { return (op << 11) | ((a || 0) << 8) | ((b || 0) << 5); }
function I(op, a, imm) { return (op << 11) | (a << 8) | (imm & 0xFF); }
function J(op, addr) { return (op << 11) | (addr & 0x7FF); }
var HALT = R(1);
var Z = TC.CPU.FZ, C = TC.CPU.FC, N = TC.CPU.FN;

function runProg(words, steps) {
  var c = new TC.CPU(); c.load(words); c.run(steps || 1000); return c;
}

// reset state
var c = new TC.CPU();
assert.strictEqual(c.sp, 0xEF); assert.strictEqual(c.pc, 0); assert.strictEqual(c.halted, false);

// NOP, HALT
c = runProg([R(0), R(0), HALT]);
assert.strictEqual(c.pc, 2); assert.ok(c.halted); assert.strictEqual(c.cycle, 3);

// LDI, MOV
c = runProg([I(2, 1, 0x42), R(3, 2, 1), HALT]);
assert.strictEqual(c.regs[1], 0x42); assert.strictEqual(c.regs[2], 0x42);

// ST, LD, STA, LDA
c = runProg([I(2, 0, 0x10), I(2, 1, 0x99), R(5, 0, 1), R(4, 2, 0), I(7, 1, 0x11), I(6, 3, 0x11), HALT]);
assert.strictEqual(c.ram[0x10], 0x99); assert.strictEqual(c.regs[2], 0x99);
assert.strictEqual(c.ram[0x11], 0x99); assert.strictEqual(c.regs[3], 0x99);

// ADD with carry, zero
c = runProg([I(2, 0, 0xFF), I(2, 1, 0x01), R(8, 0, 1), HALT]);
assert.strictEqual(c.regs[0], 0); assert.strictEqual(c.flags, Z | C);
c = runProg([I(2, 0, 0x70), I(2, 1, 0x10), R(8, 0, 1), HALT]);
assert.strictEqual(c.regs[0], 0x80); assert.strictEqual(c.flags, N);

// SUB borrow
c = runProg([I(2, 0, 3), I(2, 1, 5), R(9, 0, 1), HALT]);
assert.strictEqual(c.regs[0], 0xFE); assert.strictEqual(c.flags, C | N);
c = runProg([I(2, 0, 5), I(2, 1, 5), R(9, 0, 1), HALT]);
assert.strictEqual(c.regs[0], 0); assert.strictEqual(c.flags, Z);

// AND / OR / XOR keep C
c = runProg([I(2, 0, 0xFF), I(2, 1, 1), R(8, 0, 1), I(2, 0, 0xF0), I(2, 1, 0x0F), R(10, 0, 1), HALT]);
assert.strictEqual(c.regs[0], 0); assert.strictEqual(c.flags, Z | C);
c = runProg([I(2, 0, 0xF0), I(2, 1, 0x0F), R(11, 0, 1), HALT]);
assert.strictEqual(c.regs[0], 0xFF); assert.strictEqual(c.flags, N);
c = runProg([I(2, 0, 0xFF), I(2, 1, 0x0F), R(12, 0, 1), HALT]);
assert.strictEqual(c.regs[0], 0xF0); assert.strictEqual(c.flags, N);

// SHL / SHR carry
c = runProg([I(2, 0, 0x81), R(13, 0), HALT]);
assert.strictEqual(c.regs[0], 0x02); assert.strictEqual(c.flags, C);
c = runProg([I(2, 0, 0x01), R(14, 0), HALT]);
assert.strictEqual(c.regs[0], 0); assert.strictEqual(c.flags, Z | C);
c = runProg([I(2, 0, 0x80), R(14, 0), HALT]);
assert.strictEqual(c.regs[0], 0x40); assert.strictEqual(c.flags, 0);

// CMP / CMPI don't change register
c = runProg([I(2, 0, 4), I(2, 1, 9), R(15, 0, 1), HALT]);
assert.strictEqual(c.regs[0], 4); assert.strictEqual(c.flags, C | N);
c = runProg([I(2, 0, 7), I(17, 0, 7), HALT]);
assert.strictEqual(c.regs[0], 7); assert.strictEqual(c.flags, Z);

// ADDI / ANDI / SUBI
c = runProg([I(2, 0, 0xFE), I(16, 0, 3), HALT]);
assert.strictEqual(c.regs[0], 1); assert.strictEqual(c.flags, C);
c = runProg([I(2, 0, 0x37), I(30, 0, 0x0F), HALT]);
assert.strictEqual(c.regs[0], 7);
c = runProg([I(2, 0, 1), I(31, 0, 2), HALT]);
assert.strictEqual(c.regs[0], 0xFF); assert.strictEqual(c.flags, C | N);

// Jumps: JMP, JZ, JNZ, JC, JNC, JN (each skips an "LDI R7, 1" error marker)
function jumpCase(setup, jop, taken) {
  var p = setup.concat([J(jop, setup.length + 3), I(2, 7, 1), HALT, I(2, 6, 1), HALT]);
  var cc = runProg(p);
  assert.strictEqual(cc.regs[6], taken ? 1 : 0, 'op ' + jop);
  assert.strictEqual(cc.regs[7], taken ? 0 : 1, 'op ' + jop);
}
jumpCase([], 18, true);
jumpCase([I(2, 0, 0), I(17, 0, 0)], 19, true);
jumpCase([I(2, 0, 1), I(17, 0, 0)], 19, false);
jumpCase([I(2, 0, 1), I(17, 0, 0)], 20, true);
jumpCase([I(2, 0, 0), I(17, 0, 0)], 20, false);
jumpCase([I(2, 0, 0), I(17, 0, 1)], 21, true);
jumpCase([I(2, 0, 1), I(17, 0, 0)], 21, false);
jumpCase([I(2, 0, 1), I(17, 0, 0)], 22, true);
jumpCase([I(2, 0, 0x90), I(17, 0, 0)], 29, true);
jumpCase([I(2, 0, 0x10), I(17, 0, 0)], 29, false);

// CALL/RET nesting: main calls A, A calls B
c = runProg([
  J(23, 4),          // 0 CALL A
  I(16, 0, 1),       // 1 R0 += 1 (after return)
  HALT,              // 2
  R(0),              // 3
  I(16, 1, 1),       // 4 A: R1 += 1
  J(23, 8),          // 5 CALL B
  I(16, 3, 1),       // 6 R3 += 1 (after B)
  R(24),             // 7 RET
  I(16, 2, 1),       // 8 B: R2 += 1
  R(24)              // 9 RET
]);
assert.deepStrictEqual(Array.from(c.regs.slice(0, 4)), [1, 1, 1, 1]);
assert.strictEqual(c.rsp, 0); assert.strictEqual(c.fault, null); assert.strictEqual(c.pc, 2);

// call-stack overflow: recursive CALL to self
c = runProg([J(23, 0)]);
assert.ok(c.halted); assert.ok(/overflow/.test(c.fault)); assert.strictEqual(c.rsp, 16);
assert.strictEqual(c.cycle, 17);
// underflow
c = runProg([R(24)]);
assert.ok(c.halted); assert.ok(/underflow/.test(c.fault));

// PUSH/POP order (LIFO) and stack location
c = runProg([I(2, 0, 0x11), I(2, 1, 0x22), R(25, 0), R(25, 1), R(26, 2), R(26, 3), HALT]);
assert.strictEqual(c.regs[2], 0x22); assert.strictEqual(c.regs[3], 0x11);
assert.strictEqual(c.ram[0xEF], 0x11); assert.strictEqual(c.ram[0xEE], 0x22); assert.strictEqual(c.sp, 0xEF);

// KEY clears on read; CPU writes to F0..F2 ignored; F3 writable
c = new TC.CPU(); c.load([I(6, 0, 0xF0), I(6, 1, 0xF0), I(2, 2, 9), I(7, 2, 0xF0), I(7, 2, 0xF2), I(7, 2, 0xF3), HALT]);
c.setKey(3); c.run(100);
assert.strictEqual(c.regs[0], 3); assert.strictEqual(c.regs[1], 0);
assert.strictEqual(c.ram[0xF0], 0); assert.strictEqual(c.ram[0xF2], 0); assert.strictEqual(c.ram[0xF3], 9);

// RNG: never 0, period 255
c = new TC.CPU(); c.load([I(6, 0, 0xF1), J(18, 0)]);
var seen = {}, first = -1, period = 0, vals = [];
for (var i = 0; i < 600; i++) {
  c.run(1); vals.push(c.regs[0]); c.run(1);
}
vals.forEach(function (v) { assert.notStrictEqual(v, 0); });
for (i = 1; i < vals.length; i++) if (vals[i] === vals[0]) { period = i; break; }
assert.strictEqual(period, 255);
vals.slice(0, 255).forEach(function (v) { seen[v] = 1; });
assert.strictEqual(Object.keys(seen).length, 255);

// FRAME ticks every 2000 cycles
c = runProg([J(18, 0)], 1999); assert.strictEqual(c.ram[0xF2], 0);
c.run(1); assert.strictEqual(c.ram[0xF2], 1);
c.run(2000 * 255); assert.strictEqual(c.ram[0xF2], 0); // wraps at 256

// VRAM masking + VLD
c = runProg([I(2, 0, 0x35), I(2, 1, 0xFF), R(27, 0, 1), R(28, 2, 0), HALT]);
assert.strictEqual(c.vram[0x35], 3); assert.strictEqual(c.regs[2], 3);
c = runProg([I(2, 0, 7), I(2, 1, 6), R(27, 0, 1), HALT]);
assert.strictEqual(c.vram[7], 2);

// illegal instruction (reserved bits set in R-type) faults
c = runProg([R(3, 0, 1) | 1]);
assert.ok(c.halted); assert.ok(/illegal/.test(c.fault));

// step() trace
c = new TC.CPU(); c.load([I(2, 0, 0x10), I(2, 1, 0x05), R(5, 0, 1), R(4, 2, 0), R(27, 0, 1), R(28, 3, 0), R(8, 1, 1), HALT]);
var t = c.step();
assert.strictEqual(t.pc, 0); assert.strictEqual(t.cycle, 1);
assert.deepStrictEqual(t.regs.map(function (e) { return [e.r, e.old, e.new]; }), [[0, 0, 0x10]]);
c.step();
t = c.step(); assert.deepStrictEqual(t.writes.map(function (e) { return [e.addr, e.val]; }), [[0x10, 5]]);
assert.strictEqual(t.regs.length, 0);
t = c.step(); assert.deepStrictEqual(t.reads, [0x10]); assert.strictEqual(t.writes.length, 0);
t = c.step(); assert.deepStrictEqual(t.vwrites.map(function (e) { return [e.addr, e.val]; }), [[0x10, 1]]);
t = c.step(); assert.deepStrictEqual(t.vreads, [0x10]);
t = c.step(); assert.strictEqual(t.flags.old, 0); assert.strictEqual(t.flags.new, 0);
assert.strictEqual(c.regs[1], 10);
t = c.step(); assert.ok(t.halted); assert.strictEqual(t.fault, null);
t = c.step(); assert.ok(t.halted); assert.strictEqual(t.cycle, 8);

console.log('cpu tests ok');
