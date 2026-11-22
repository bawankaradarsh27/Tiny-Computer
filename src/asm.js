var TC = (typeof globalThis.TC !== 'undefined') ? globalThis.TC : {};

// TC-8 assembler + disassembler. No DOM.
(function () {
  // Operand forms: '' none, 'rr' Rd,Rs, 'r' Rd, 'ri' Rd,imm, 'rm' Rd,[Rs],
  // 'mr' [Ra],Rs, 'ra' Rd,[imm], 'ar' [imm],Rs, 'j' addr
  var OPS = [
    ['NOP', ''], ['HALT', ''], ['LDI', 'ri'], ['MOV', 'rr'], ['LD', 'rm'], ['ST', 'mr'],
    ['LDA', 'ra'], ['STA', 'ar'], ['ADD', 'rr'], ['SUB', 'rr'], ['AND', 'rr'], ['OR', 'rr'],
    ['XOR', 'rr'], ['SHL', 'r'], ['SHR', 'r'], ['CMP', 'rr'], ['ADDI', 'ri'], ['CMPI', 'ri'],
    ['JMP', 'j'], ['JZ', 'j'], ['JNZ', 'j'], ['JC', 'j'], ['JNC', 'j'], ['CALL', 'j'],
    ['RET', ''], ['PUSH', 'r'], ['POP', 'r'], ['VST', 'mr'], ['VLD', 'rm'], ['JN', 'j'],
    ['ANDI', 'ri'], ['SUBI', 'ri']
  ];
  var BY_NAME = {};
  OPS.forEach(function (o, i) { BY_NAME[o[0]] = { op: i, form: o[1] }; });
  var NARGS = { '': 0, r: 1, j: 1, rr: 2, ri: 2, rm: 2, mr: 2, ra: 2, ar: 2 };
  var IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  var REG = /^R([0-7])$/i;

  function parseNum(s) {
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s.slice(2), 16);
    if (/^0b[01]+$/i.test(s)) return parseInt(s.slice(2), 2);
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
    return null;
  }

  // Evaluate "a + b - c". Returns {val} or {err} or {undef: name}.
  function evalExpr(s, syms) {
    s = s.replace(/\s+/g, '');
    if (!s) return { err: 'missing value' };
    var parts = s.match(/[+-]?[^+-]+/g);
    if (!parts || parts.join('') !== s) return { err: 'bad expression "' + s + '"' };
    var total = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], sign = 1;
      if (p[0] === '+' || p[0] === '-') { if (p[0] === '-') sign = -1; p = p.slice(1); }
      var n = parseNum(p);
      if (n === null) {
        if (!IDENT.test(p) || REG.test(p)) return { err: 'bad value "' + p + '"' };
        var k = p.toUpperCase();
        if (!(k in syms)) return { undef: p };
        n = syms[k];
      }
      total += sign * n;
    }
    return { val: total };
  }

  function assemble(src) {
    var lines = src.split(/\r?\n/);
    var errors = [], syms = {}, equs = [], items = [], reserved = {};
    var labels = {}, memSyms = {};   // address -> name (code labels / symbols used as [mem])
    var pc = 0;
    function err(line, msg) { errors.push({ line: line, msg: msg }); }

    // Pass 1: labels, .equ, .org, instruction addresses.
    for (var i = 0; i < lines.length; i++) {
      var ln = i + 1, text = lines[i].replace(/;.*/, '').trim();
      var m;
      while ((m = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/))) {
        var name = m[1].toUpperCase();
        if (REG.test(name) || BY_NAME[name]) err(ln, 'bad label name "' + m[1] + '"');
        else if (name in syms || reserved[name]) err(ln, 'duplicate label "' + m[1] + '"');
        else { syms[name] = pc; if (!(pc in labels)) labels[pc] = m[1]; }
        text = text.slice(m[0].length).trim();
      }
      if (!text) continue;
      var sp = text.search(/\s/);
      var mn = (sp < 0 ? text : text.slice(0, sp)).toUpperCase();
      var rest = sp < 0 ? '' : text.slice(sp).trim();
      var args = rest ? rest.split(',').map(function (a) { return a.trim(); }) : [];
      if (mn === '.EQU') {
        if (args.length !== 2) { err(ln, '.equ needs NAME, value'); continue; }
        if (!IDENT.test(args[0]) || REG.test(args[0])) { err(ln, 'bad .equ name "' + args[0] + '"'); continue; }
        var en = args[0].toUpperCase();
        if (en in syms || reserved[en]) { err(ln, 'duplicate label "' + args[0] + '"'); continue; }
        var ev = evalExpr(args[1], syms);
        if (ev.val !== undefined) syms[en] = ev.val;
        else if (ev.err) err(ln, ev.err);
        else { reserved[en] = true; equs.push({ name: en, expr: args[1], line: ln, done: false }); }
        continue;
      }
      if (mn === '.ORG') {
        var o = evalExpr(rest, syms);
        if (o.err || o.undef) { err(ln, o.err || ('undefined symbol "' + o.undef + '"')); continue; }
        if (o.val < 0 || o.val > 2047) { err(ln, '.org address out of range'); continue; }
        pc = o.val; continue;
      }
      var def = BY_NAME[mn];
      if (!def) { err(ln, 'unknown mnemonic "' + mn + '"'); continue; }
      if (args.length !== NARGS[def.form]) {
        err(ln, mn + ' expects ' + NARGS[def.form] + ' operand(s), got ' + args.length); continue;
      }
      if (pc > 2047) { err(ln, 'program too large'); continue; }
      items.push({ line: ln, addr: pc, op: def.op, form: def.form, args: args, mn: mn });
      pc++;
    }

    // Resolve deferred .equ (forward references to labels or later equs).
    var progress = true;
    while (progress) {
      progress = false;
      equs.forEach(function (e) {
        if (e.done) return;
        var r = evalExpr(e.expr, syms);
        if (r.undef) return;
        e.done = true; progress = true;
        if (r.err) { err(e.line, r.err); return; }
        syms[e.name] = r.val;
      });
    }
    equs.forEach(function (e) {
      if (e.done) return;
      var r = evalExpr(e.expr, syms);
      err(e.line, r.undef ? 'undefined symbol "' + r.undef + '"' : 'circular .equ');
    });

    // Pass 2: encode.
    var words = [], map = [];
    items.forEach(function (it) {
      var ln = it.line, a = 0, b = 0, imm = 0, ok = true;
      function reg(s) {
        if (s === null) return 0;
        var m = s.match(REG);
        if (!m) { err(ln, 'bad register "' + s + '"'); ok = false; return 0; }
        return +m[1];
      }
      function mem(s) {
        var m = s.match(/^\[(.*)\]$/);
        if (!m) { err(ln, 'expected [..] memory operand, got "' + s + '"'); ok = false; return null; }
        return m[1].trim();
      }
      function val(s, lo, hi, what) {
        if (s === null) return 0;
        var r = evalExpr(s, syms);
        if (r.undef) { err(ln, 'undefined symbol "' + r.undef + '"'); ok = false; return 0; }
        if (r.err) { err(ln, r.err); ok = false; return 0; }
        if (r.val < lo || r.val > hi) { err(ln, what + ' out of range: ' + r.val); ok = false; return 0; }
        return r.val;
      }
      // remember symbols used inside [..] so the UI can caption those RAM cells
      function noteMem(s) {
        if (s === null) return;
        s.split(/[+-]/).forEach(function (tok) {
          tok = tok.trim();
          var k = tok.toUpperCase();
          if (IDENT.test(tok) && !REG.test(tok) && (k in syms) && !(syms[k] in memSyms)) memSyms[syms[k]] = tok;
        });
      }
      var x = it.args;
      switch (it.form) {
        case 'rr': a = reg(x[0]); b = reg(x[1]); break;
        case 'r': a = reg(x[0]); break;
        case 'ri': a = reg(x[0]); imm = val(x[1], -128, 255, 'immediate'); break;
        case 'rm': a = reg(x[0]); b = reg(mem(x[1])); break;
        case 'mr': a = reg(mem(x[0])); b = reg(x[1]); break;
        case 'ra': a = reg(x[0]); var m1 = mem(x[1]); imm = val(m1, 0, 255, 'address'); noteMem(m1); break;
        case 'ar': var m2 = mem(x[0]); imm = val(m2, 0, 255, 'address'); a = reg(x[1]); noteMem(m2); break;
        case 'j': imm = val(x[0], 0, 2047, 'jump address'); break;
      }
      if (!ok) return;
      var w = it.op << 11;
      if (it.form === 'j') w |= imm;
      else if (it.form === 'ri' || it.form === 'ra' || it.form === 'ar') w |= (a << 8) | (imm & 0xFF);
      else w |= (a << 8) | (b << 5);
      words[it.addr] = w; map[it.addr] = ln;
    });

    errors.sort(function (p, q) { return p.line - q.line; });
    for (var k = 0; k < words.length; k++) { if (words[k] === undefined) words[k] = 0; if (map[k] === undefined) map[k] = 0; }
    var symbols = {};
    Object.keys(syms).forEach(function (s) { symbols[s] = syms[s]; });
    return {
      words: errors.length ? [] : words, map: errors.length ? [] : map, errors: errors, symbols: symbols,
      labels: labels, memSyms: memSyms
    };
  }

  function hex2(n) { return '0x' + (n < 16 ? '0' : '') + n.toString(16).toUpperCase(); }

  function disassemble(w) {
    w &= 0xFFFF;
    var op = w >> 11, a = (w >> 8) & 7, b = (w >> 5) & 7, imm = w & 0xFF, def = OPS[op];
    var mn = def[0], form = def[1];
    if ((form === '' || form === 'rr' || form === 'r' || form === 'rm' || form === 'mr') && (w & 0x1F))
      return '.word 0x' + ('000' + w.toString(16).toUpperCase()).slice(-4);
    switch (form) {
      case '': return mn;
      case 'rr': return mn + ' R' + a + ', R' + b;
      case 'r': return mn + ' R' + a;
      case 'ri': return mn + ' R' + a + ', ' + imm;
      case 'rm': return mn + ' R' + a + ', [R' + b + ']';
      case 'mr': return mn + ' [R' + a + '], R' + b;
      case 'ra': return mn + ' R' + a + ', [' + hex2(imm) + ']';
      case 'ar': return mn + ' [' + hex2(imm) + '], R' + a;
      case 'j': return mn + ' ' + (w & 0x7FF);
    }
  }

  TC.assemble = assemble;
  TC.disassemble = disassemble;
  TC.OPS = OPS;
})();

if (typeof module !== 'undefined') module.exports = globalThis.TC = TC; else globalThis.TC = TC;
