var assert = require('assert');
require('../src/cpu.js');
var TC = require('../src/asm.js');

// Round-trip: every instruction form, in canonical disassembler syntax.
var canon = [
  'NOP', 'HALT', 'LDI R1, 200', 'MOV R2, R3', 'LD R4, [R5]', 'ST [R6], R7',
  'LDA R0, [0xF0]', 'STA [0xF3], R1', 'ADD R0, R1', 'SUB R2, R3', 'AND R4, R5',
  'OR R6, R7', 'XOR R0, R7', 'SHL R3', 'SHR R4', 'CMP R5, R6', 'ADDI R1, 5',
  'CMPI R2, 255', 'JMP 7', 'JZ 0', 'JNZ 2047', 'JC 12', 'JNC 13', 'CALL 100',
  'RET', 'PUSH R2', 'POP R3', 'VST [R1], R2', 'VLD R3, [R4]', 'JN 5',
  'ANDI R0, 15', 'SUBI R7, 1'
];
var r = TC.assemble(canon.join('\n'));
assert.deepStrictEqual(r.errors, []);
assert.strictEqual(r.words.length, canon.length);
r.words.forEach(function (w, i) { assert.strictEqual(TC.disassemble(w), canon[i]); });
// every opcode covered
assert.deepStrictEqual(r.words.map(function (w) { return w >> 11; }).sort(function (a, b) { return a - b; }),
  Array.from({ length: 32 }, function (_, i) { return i; }));

// Case-insensitivity, comments, number formats, negative immediates
r = TC.assemble('  ldi r1, 0x1f ; hex\nLdI R2, 0b101\naddi r3, -1\n');
assert.deepStrictEqual(r.errors, []);
assert.deepStrictEqual(r.words.map(TC.disassemble), ['LDI R1, 31', 'LDI R2, 5', 'ADDI R3, 255']);

// Forward-referenced labels, .equ (incl. forward + expressions), .org, source map
var src = [
  '.equ KEY, 0xF0',          // 1
  '.equ LATER, end - 1',     // 2  forward reference to a label
  'start:',                  // 3
  '  LDA R0, [KEY]',         // 4
  '  JMP done',              // 5  forward ref
  '  LDI R1, LATER',         // 6
  '.org 0x10',               // 7
  'done: LDI R2, KEY + 2 - 1', // 8 label + instr on same line
  'end: HALT'                // 9
].join('\n');
r = TC.assemble(src);
assert.deepStrictEqual(r.errors, []);
assert.strictEqual(r.symbols.START, 0);
assert.strictEqual(r.symbols.DONE, 0x10);
assert.strictEqual(r.symbols.END, 0x11);
assert.strictEqual(r.symbols.LATER, 0x10);
assert.strictEqual(r.words.length, 0x12);
assert.strictEqual(TC.disassemble(r.words[0]), 'LDA R0, [0xF0]');
assert.strictEqual(TC.disassemble(r.words[1]), 'JMP 16');
assert.strictEqual(TC.disassemble(r.words[2]), 'LDI R1, 16');
assert.strictEqual(r.words[5], 0); // gap filled
assert.strictEqual(TC.disassemble(r.words[0x10]), 'LDI R2, 241');
assert.strictEqual(r.map[0], 4); assert.strictEqual(r.map[1], 5); assert.strictEqual(r.map[2], 6);
assert.strictEqual(r.map[0x10], 8); assert.strictEqual(r.map[0x11], 9);

// .org can use an earlier .equ
r = TC.assemble('.equ BASE, 3\n.org BASE\nNOP');
assert.deepStrictEqual(r.errors, []); assert.strictEqual(r.words.length, 4); assert.strictEqual(r.map[3], 3);

// Assembled code actually runs
r = TC.assemble('LDI R0, 3\nloop: SUBI R0, 1\nJNZ loop\nSTA [0x40], R0\nHALT');
var c = new TC.CPU(); c.load(r.words); c.run(100);
assert.ok(c.halted); assert.strictEqual(c.regs[0], 0); assert.strictEqual(c.cycle, 1 + 3 * 2 + 2);

// Many different errors, all reported, correct lines, no words
var bad = [
  'start: NOP',          // 1 ok
  'FOO R1, R2',          // 2 unknown mnemonic
  'MOV R1, R9',          // 3 bad register
  'JMP nowhere',         // 4 undefined symbol
  'LDI R1, 300',         // 5 immediate out of range
  'start: HALT',         // 6 duplicate label
  'ADD R1',              // 7 wrong operand count
  'LD R1, R2',           // 8 missing brackets
  'LDA R0, [0x100]'      // 9 address out of range
].join('\n');
r = TC.assemble(bad);
assert.deepStrictEqual(r.words, []);
var lines = r.errors.map(function (e) { return e.line; });
assert.deepStrictEqual(lines, [2, 3, 4, 5, 6, 7, 8, 9]);
assert.ok(/unknown mnemonic/.test(r.errors[0].msg));
assert.ok(/bad register/.test(r.errors[1].msg));
assert.ok(/undefined symbol/.test(r.errors[2].msg));
assert.ok(/out of range/.test(r.errors[3].msg));
assert.ok(/duplicate label/.test(r.errors[4].msg));
assert.ok(/operand/.test(r.errors[5].msg));

// Undefined symbol inside .equ
r = TC.assemble('.equ A, B + 1\nNOP');
assert.strictEqual(r.errors.length, 1); assert.strictEqual(r.errors[0].line, 1);

// memSyms: only symbols used inside [..] (incl. expressions); labels by address
r = TC.assemble('.equ HEAD_I, 0xA0\n.equ BODY, 0x20\n.equ STEP, 4\nstart: LDA R0, [HEAD_I]\nSTA [BODY+1], R0\nLDI R1, STEP\nloop: JMP loop');
assert.deepStrictEqual(r.errors, []);
assert.deepStrictEqual(r.memSyms, { 0xA0: 'HEAD_I', 0x20: 'BODY' });
assert.deepStrictEqual(r.labels, { 0: 'start', 3: 'loop' });

console.log('asm tests ok');
