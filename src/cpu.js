var TC = (typeof globalThis.TC !== 'undefined') ? globalThis.TC : {};

// TC-8 emulator core. No DOM.
(function () {
  var KEY = 0xF0, RNG = 0xF1, FRAME = 0xF2;
  var FRAME_CYCLES = 2000;
  // Flags are packed into one number: Z=1, C=2, N=4.
  var FZ = 1, FC = 2, FN = 4;

  function CPU() {
    this.prog = new Uint16Array(2048);
    this.ram = new Uint8Array(256);
    this.vram = new Uint8Array(256);
    this.regs = new Uint8Array(8);
    this.rstack = new Uint16Array(16);
    // One reusable trace object (allocation-light). Callers must copy anything
    // they want to keep past the next step().
    this._re = { r: 0, old: 0, new: 0 };
    this._we = { addr: 0, val: 0 };
    this._vwe = { addr: 0, val: 0 };
    this._fl = { old: 0, new: 0 };
    this.trace = {
      pc: 0, word: 0, cycle: 0, regs: [], flags: this._fl, reads: [], writes: [],
      vreads: [], vwrites: [], halted: false, fault: null
    };
    this.reset();
  }

  CPU.FZ = FZ; CPU.FC = FC; CPU.FN = FN;

  CPU.prototype.load = function (words) {
    this.prog.fill(0);
    for (var i = 0; i < words.length && i < 2048; i++) this.prog[i] = words[i] & 0xFFFF;
    this.reset();
  };

  CPU.prototype.reset = function () {
    this.regs.fill(0);
    this.ram.fill(0);
    this.vram.fill(0);
    this.pc = 0;
    this.sp = 0xEF;
    this.flags = 0;
    this.cycle = 0;
    this.rsp = 0;
    this.lfsr = 0xA5;
    this.halted = false;
    this.fault = null;
  };

  CPU.prototype.setKey = function (k) { this.ram[KEY] = k & 0xFF; };

  // Data RAM read with I/O side effects.
  CPU.prototype._read = function (addr, tr) {
    var v;
    if (addr === KEY) { v = this.ram[KEY]; this.ram[KEY] = 0; }
    else if (addr === RNG) {
      var x = this.lfsr;
      x = (x >> 1) ^ ((x & 1) ? 0xB8 : 0);
      this.lfsr = x; this.ram[RNG] = x; v = x;
    } else v = this.ram[addr];
    if (tr) tr.reads.push(addr);
    return v;
  };

  CPU.prototype._write = function (addr, val, tr) {
    if (addr >= KEY && addr <= FRAME) return; // read-only I/O
    this.ram[addr] = val;
    if (tr) { var e = this._we; e.addr = addr; e.val = val; tr.writes.push(e); }
  };

  CPU.prototype._setReg = function (r, v, tr) {
    if (tr) { var e = this._re; e.r = r; e.old = this.regs[r]; e.new = v; tr.regs.push(e); }
    this.regs[r] = v;
  };

  CPU.prototype._zn = function (v) {
    this.flags = (this.flags & FC) | (v === 0 ? FZ : 0) | (v & 0x80 ? FN : 0);
  };
  CPU.prototype._add = function (a, b) {
    var r = a + b, v = r & 0xFF;
    this.flags = (v === 0 ? FZ : 0) | (r > 0xFF ? FC : 0) | (v & 0x80 ? FN : 0);
    return v;
  };
  CPU.prototype._sub = function (a, b) {
    var v = (a - b) & 0xFF;
    this.flags = (v === 0 ? FZ : 0) | (b > a ? FC : 0) | (v & 0x80 ? FN : 0);
    return v;
  };

  CPU.prototype._fault = function (msg) { this.fault = msg; this.halted = true; };

  CPU.prototype._exec = function (tr) {
    if (this.halted) return;
    var pc = this.pc, w = this.prog[pc];
    var op = w >> 11, a = (w >> 8) & 7, b = (w >> 5) & 7, imm = w & 0xFF, addr = w & 0x7FF;
    var next = (pc + 1) & 0x7FF;
    var R = this.regs, f = this.flags, v;
    if (tr) {
      tr.pc = pc; tr.word = w; tr.regs.length = 0; tr.reads.length = 0;
      tr.writes.length = 0; tr.vreads.length = 0; tr.vwrites.length = 0;
      this._fl.old = f;
    }
    // R-type words must have their reserved low 5 bits clear.
    var rtype = op <= 1 || op === 3 || op === 4 || op === 5 || (op >= 8 && op <= 15) ||
      op === 24 || op === 25 || op === 26 || op === 27 || op === 28;
    if (rtype && (w & 0x1F)) { this._fault('illegal instruction 0x' + w.toString(16)); }
    else switch (op) {
      case 0: break;
      case 1: this.halted = true; next = pc; break;
      case 2: this._setReg(a, imm, tr); break;
      case 3: this._setReg(a, R[b], tr); break;
      case 4: this._setReg(a, this._read(R[b], tr), tr); break;
      case 5: this._write(R[a], R[b], tr); break;
      case 6: this._setReg(a, this._read(imm, tr), tr); break;
      case 7: this._write(imm, R[a], tr); break;
      case 8: this._setReg(a, this._add(R[a], R[b]), tr); break;
      case 9: this._setReg(a, this._sub(R[a], R[b]), tr); break;
      case 10: v = R[a] & R[b]; this._zn(v); this._setReg(a, v, tr); break;
      case 11: v = R[a] | R[b]; this._zn(v); this._setReg(a, v, tr); break;
      case 12: v = R[a] ^ R[b]; this._zn(v); this._setReg(a, v, tr); break;
      case 13: v = (R[a] << 1) & 0xFF; this.flags = R[a] & 0x80 ? FC : 0; this._zn(v); this._setReg(a, v, tr); break;
      case 14: v = R[a] >> 1; this.flags = R[a] & 1 ? FC : 0; this._zn(v); this._setReg(a, v, tr); break;
      case 15: this._sub(R[a], R[b]); break;
      case 16: this._setReg(a, this._add(R[a], imm), tr); break;
      case 17: this._sub(R[a], imm); break;
      case 18: next = addr; break;
      case 19: if (f & FZ) next = addr; break;
      case 20: if (!(f & FZ)) next = addr; break;
      case 21: if (f & FC) next = addr; break;
      case 22: if (!(f & FC)) next = addr; break;
      case 23:
        if (this.rsp >= 16) { this._fault('return stack overflow'); next = pc; break; }
        this.rstack[this.rsp++] = next; next = addr; break;
      case 24:
        if (this.rsp === 0) { this._fault('return stack underflow'); next = pc; break; }
        next = this.rstack[--this.rsp]; break;
      case 25: this._write(this.sp, R[a], tr); this.sp = (this.sp - 1) & 0xFF; break;
      case 26: this.sp = (this.sp + 1) & 0xFF; this._setReg(a, this._read(this.sp, tr), tr); break;
      case 27:
        v = R[b] & 3; this.vram[R[a]] = v;
        if (tr) { this._vwe.addr = R[a]; this._vwe.val = v; tr.vwrites.push(this._vwe); }
        break;
      case 28: if (tr) tr.vreads.push(R[b]); this._setReg(a, this.vram[R[b]], tr); break;
      case 29: if (f & FN) next = addr; break;
      case 30: v = R[a] & imm; this._zn(v); this._setReg(a, v, tr); break;
      case 31: this._setReg(a, this._sub(R[a], imm), tr); break;
    }
    if (this.fault) next = pc;
    this.pc = next;
    this.cycle++;
    if (this.cycle % FRAME_CYCLES === 0) this.ram[FRAME] = (this.ram[FRAME] + 1) & 0xFF;
  };

  CPU.prototype.step = function () {
    var tr = this.trace;
    if (this.halted) {
      tr.pc = this.pc; tr.word = this.prog[this.pc]; tr.regs.length = 0; tr.reads.length = 0;
      tr.writes.length = 0; tr.vreads.length = 0; tr.vwrites.length = 0;
      this._fl.old = this._fl.new = this.flags;
    } else this._exec(tr);
    this._fl.new = this.flags;
    tr.cycle = this.cycle; tr.halted = this.halted; tr.fault = this.fault;
    return tr;
  };

  CPU.prototype.run = function (maxSteps) {
    var n = 0;
    while (n < maxSteps && !this.halted) { this._exec(null); n++; }
    return n;
  };

  TC.CPU = CPU;
})();

if (typeof module !== 'undefined') module.exports = globalThis.TC = TC; else globalThis.TC = TC;
