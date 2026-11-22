var TC = (typeof globalThis.TC !== 'undefined') ? globalThis.TC : {};

// TC-8 UI. Pure logic (Session, fade, helpers) is DOM-free so node tests can run it;
// the DOM part only starts in a browser.
(function () {
  var REG_FLASH_MS = 300, MEM_FLASH_MS = 400, TRACE_VISUALS = 64;
  var PALETTE = [[16, 20, 19], [61, 220, 132], [255, 77, 79], [240, 240, 236]];

  // Flash intensity: full at t0, decays with an ease-out curve to 0 at dur.
  function fade(now, t0, dur) {
    if (!t0) return 0;
    var x = (now - t0) / dur;
    if (x < 0 || x >= 1) return 0;
    var k = 1 - x;
    return k * k;
  }

  function hex(n, w) { var s = n.toString(16).toUpperCase(); while (s.length < w) s = '0' + s; return s; }

  // ---------- Session: run loop + visual bookkeeping (no DOM) ----------
  function Session(cpu) {
    this.cpu = cpu;
    this.ips = 40000;                    // ~5 snake steps/s with STEP_FRAMES 4
    this.budget = 0;
    this.running = false;
    this.map = [];
    this.lastRead = new Float64Array(256);
    this.lastWrite = new Float64Array(256);
    this.regT = new Float64Array(8);
    this.bps = {};          // source line -> true
    this.skipBp = false;    // let the first instruction after Run pass its breakpoint
    this.hitLine = 0;       // line of the breakpoint we paused at (0 = none)
    this.trailPc = new Uint16Array(8);   // ring of the last 8 executed instructions
    this.trailW = new Uint16Array(8);
    this.trailN = 0;                     // total recorded (also a change counter)
    this.info = { mem: {}, labels: {} }; // symbol names from the assembler
  }

  // Last executed instructions, oldest first: [{pc, word}]
  Session.prototype.trail = function () {
    var out = [];
    for (var i = Math.max(0, this.trailN - 8); i < this.trailN; i++) out.push({ pc: this.trailPc[i & 7], word: this.trailW[i & 7] });
    return out;
  };

  // Assemble and load. On errors nothing changes and the result's errors are returned.
  Session.prototype.load = function (text) {
    var r = TC.assemble(text);
    if (r.errors.length) return r;
    this.cpu.load(r.words);
    this.map = r.map;
    this.info = { mem: r.memSyms, labels: r.labels };
    this.bps = {};
    this.hitLine = 0;
    this.budget = 0;
    this.clearVisuals();
    return r;
  };

  Session.prototype.run = function () {
    if (this.cpu.halted) return;
    this.running = true; this.skipBp = true; this.hitLine = 0; this.budget = 0;
  };
  Session.prototype.pause = function () { this.running = false; this.budget = 0; };

  Session.prototype.stepOnce = function (now) {
    this.pause();
    this.hitLine = 0;
    if (this.cpu.halted) return null;
    var tr = this.cpu.step();
    this.apply(tr, now, true);
    return tr;
  };

  Session.prototype.reset = function () {
    this.cpu.reset(); this.clearVisuals(); this.hitLine = 0; this.budget = 0; this.skipBp = true;
  };

  // Only lines that hold an instruction can carry a breakpoint.
  Session.prototype.toggleBp = function (line) {
    if (this.map.indexOf(line) < 0) return false;
    if (this.bps[line]) delete this.bps[line]; else this.bps[line] = true;
    return true;
  };

  Session.prototype.apply = function (tr, now, regs) {
    var i, k = this.trailN++ & 7;
    this.trailPc[k] = tr.pc; this.trailW[k] = tr.word;
    for (i = 0; i < tr.reads.length; i++) this.lastRead[tr.reads[i]] = now;
    for (i = 0; i < tr.writes.length; i++) this.lastWrite[tr.writes[i].addr] = now;
    if (regs) for (i = 0; i < tr.regs.length; i++) {
      var e = tr.regs[i];
      if (e.old !== e.new) this.regT[e.r] = now;
    }
  };

  // Advance by dtMs of wall time at this.ips. Fractional budget so 1..10 ips work.
  Session.prototype.frame = function (dtMs, now) {
    if (!this.running) return 0;
    if (dtMs > 100) dtMs = 100;          // tab was hidden: don't try to catch up
    this.budget += this.ips * dtMs / 1000;
    var n = Math.floor(this.budget), cpu = this.cpu, done = 0;
    this.budget -= n;
    for (var i = 0; i < n; i++) {
      if (cpu.halted) break;
      if (this.skipBp) this.skipBp = false;
      else if (this.bps[this.map[cpu.pc]]) {
        this.hitLine = this.map[cpu.pc]; this.running = false; this.budget = 0; break;
      }
      // Only the last 64 traces of a frame drive register flashes; every trace
      // marks the memory cells it touched.
      this.apply(cpu.step(), now, i >= n - TRACE_VISUALS);
      done++;
    }
    if (cpu.halted) this.running = false;
    return done;
  };

  Session.prototype.clearVisuals = function () {
    this.lastRead.fill(0); this.lastWrite.fill(0); this.regT.fill(0);
    this.trailN = 0;
  };

  // Memory cells: hold near full strength, then fall off at the end of the window,
  // so a cell touched in the last ~400 ms stays clearly lit.
  function memFade(now, t0, dur) {
    if (!t0) return 0;
    var x = (now - t0) / dur;
    if (x < 0 || x >= 1) return 0;
    return 1 - x * x;
  }

  // One plain-English line for an executed instruction and what it changed.
  var COLORS = ['dark', 'green', 'red', 'white'];
  var CONDS = { 19: 'the result was zero', 20: 'the result was not zero', 21: 'there was a carry',
    22: 'there was no carry', 29: 'the result was negative' };
  var ALU = { 8: '+', 9: '-', 10: 'AND', 11: 'OR', 12: 'XOR' };
  function describe(tr, nextPc, info) {
    var w = tr.word, op = w >> 11, a = (w >> 8) & 7, b = (w >> 5) & 7, imm = w & 0xFF, addr = w & 0x7FF;
    var mem = (info && info.mem) || {}, labels = (info && info.labels) || {};
    var Ra = 'R' + a, Rb = 'R' + b, s;
    function ram(x) { return 'RAM[0x' + hex(x, 2) + ']' + (mem[x] ? ' (' + mem[x] + ')' : ''); }
    function lab(x) { return labels[x] || ('0x' + hex(x, 3)); }
    function px(p) { return '(' + (p & 15) + ',' + (p >> 4) + ')'; }
    switch (op) {
      case 0: s = 'Does nothing.'; break;
      case 1: s = 'Stops the CPU.'; break;
      case 2: s = 'Puts ' + imm + ' into ' + Ra + '.'; break;
      case 3: s = 'Copies ' + Rb + ' into ' + Ra + '.'; break;
      case 4: s = 'Loads ' + Ra + ' from ' + (tr.reads.length ? ram(tr.reads[0]) : 'RAM') + ', the address in ' + Rb + '.'; break;
      case 5: s = 'Stores ' + Rb + ' at the address in ' + Ra + (tr.writes.length ? '' : ' (read-only I/O: ignored)') + '.'; break;
      case 6: s = 'Loads ' + Ra + ' from ' + ram(imm) + '.'; break;
      case 7: s = 'Stores ' + Ra + ' into ' + ram(imm) + (tr.writes.length ? '' : ' (read-only I/O: ignored)') + '.'; break;
      case 8: case 9: case 10: case 11: case 12: s = 'Sets ' + Ra + ' = ' + Ra + ' ' + ALU[op] + ' ' + Rb + '.'; break;
      case 13: s = 'Shifts ' + Ra + ' left one bit.'; break;
      case 14: s = 'Shifts ' + Ra + ' right one bit.'; break;
      case 15: s = 'Compares ' + Ra + ' with ' + Rb + ' (sets flags only).'; break;
      case 16: s = 'Adds ' + imm + ' to ' + Ra + '.'; break;
      case 17: s = 'Compares ' + Ra + ' with ' + imm + ' (sets flags only).'; break;
      case 18: s = 'Jumps to ' + lab(addr) + '.'; break;
      case 19: case 20: case 21: case 22: case 29:
        s = 'Jumps to ' + lab(addr) + ' if ' + CONDS[op] + ': ' + (nextPc === addr ? 'jumped.' : 'did not jump.'); break;
      case 23: s = 'Calls subroutine ' + lab(addr) + '.'; break;
      case 24: s = 'Returns to 0x' + hex(nextPc, 3) + '.'; break;
      case 25: s = 'Pushes ' + Ra + ' onto the stack.'; break;
      case 26: s = 'Pops the top of the stack into ' + Ra + '.'; break;
      case 27: s = 'Paints a screen pixel from ' + Rb + ' at the position in ' + Ra + '.'; break;
      case 28: s = 'Reads screen pixel ' + (tr.vreads.length ? px(tr.vreads[0]) : '') + ' into ' + Ra + '.'; break;
      case 30: s = 'ANDs ' + Ra + ' with ' + imm + '.'; break;
      case 31: s = 'Subtracts ' + imm + ' from ' + Ra + '.'; break;
    }
    var parts = [], i;
    for (i = 0; i < tr.regs.length; i++) {
      var e = tr.regs[i];
      if (e.old !== e.new) parts.push('R' + e.r + ' ' + hex(e.old, 2) + ' → ' + hex(e.new, 2));
    }
    for (i = 0; i < tr.writes.length; i++) parts.push(ram(tr.writes[i].addr) + ' = ' + hex(tr.writes[i].val, 2));
    for (i = 0; i < tr.vwrites.length; i++) parts.push('pixel ' + px(tr.vwrites[i].addr) + ' = ' + COLORS[tr.vwrites[i].val]);
    if (tr.flags.old !== tr.flags.new) parts.push('flags ' + flagStr(tr.flags.old) + ' → ' + flagStr(tr.flags.new));
    return s + ' ' + (parts.length ? 'Changed: ' + parts.join(', ') + '.' : 'Nothing changed.');
  }
  function flagStr(f) {
    var s = (f & 1 ? 'Z' : '') + (f & 2 ? 'C' : '') + (f & 4 ? 'N' : '');
    return s || 'none';
  }

  // Speed slider: 0..1000 on a log scale from 1 to 200,000 instructions/second.
  var MAX_IPS = 200000, SLIDER_MAX = 1000;
  function sliderToIps(v) { return Math.max(1, Math.round(Math.pow(MAX_IPS, v / SLIDER_MAX))); }
  function ipsToSlider(ips) { return Math.round(Math.log(Math.max(1, ips)) / Math.log(MAX_IPS) * SLIDER_MAX); }

  TC.UI = {
    Session: Session, fade: fade, memFade: memFade, describe: describe, hex: hex,
    sliderToIps: sliderToIps, ipsToSlider: ipsToSlider,
    REG_FLASH_MS: REG_FLASH_MS, MEM_FLASH_MS: MEM_FLASH_MS
  };

  // ---------- DOM ----------
  if (typeof document === 'undefined') return;

  var $ = function (id) { return document.getElementById(id); };
  var cpu, ses, src = '', lineEls = [], curLine = 0, lastScroll = 0, shownN = -1;
  var regEls = [], regCache = [], scr, sctx, img, mem, mctx, memW, memH;
  var memFont = 'monospace', CELL_W = 26, CELL_H = 26, memDpr = 0, GUT_X = 24, GUT_Y = 18;
  var IO_LABELS = { 0xF0: 'key', 0xF1: 'rng', 0xF2: 'frame', 0xF3: 'score' };
  var captions = IO_LABELS;

  // RAM captions: I/O defaults, overridden by symbols the program uses as [addresses].
  function buildCaptions(memSyms) {
    var out = {}, k;
    for (k in IO_LABELS) out[k] = IO_LABELS[k];
    for (k in memSyms) out[k] = memSyms[k].toLowerCase().replace(/_i$/, '').slice(0, 5);
    return out;
  }

  function buildRegs() {
    var box = $('regs');
    for (var r = 0; r < 8; r++) {
      var d = document.createElement('div');
      d.className = 'reg';
      d.innerHTML = '<span>R' + r + '</span><span><b>00</b> <i>0</i></span>';
      box.appendChild(d);
      regEls.push({ el: d, hex: d.querySelector('b'), dec: d.querySelector('i') });
      regCache.push({ v: -1, a: -1 });
    }
  }

  function buildListing(text) {
    var box = $('listing');
    box.textContent = '';
    lineEls = [null];
    var lines = text.split(/\r?\n/), frag = document.createDocumentFragment();
    for (var i = 0; i < lines.length; i++) {
      var row = document.createElement('div');
      row.className = 'ln';
      var no = document.createElement('span');
      no.className = 'no'; no.textContent = String(i + 1); no.dataset.line = String(i + 1);
      var tx = document.createElement('span');
      tx.className = 'tx';
      var s = lines[i], c = s.indexOf(';');
      if (c >= 0) {
        tx.appendChild(document.createTextNode(s.slice(0, c)));
        var cm = document.createElement('span'); cm.className = 'cm'; cm.textContent = s.slice(c);
        tx.appendChild(cm);
      } else tx.textContent = s || ' ';
      row.appendChild(no); row.appendChild(tx);
      frag.appendChild(row);
      lineEls.push(row);
    }
    box.appendChild(frag);
    curLine = 0;
  }

  function setupMem() {
    mem = $('mem');
    var dpr = memDpr = window.devicePixelRatio || 1;
    memW = GUT_X + 16 * CELL_W; memH = GUT_Y + 16 * CELL_H;
    mem.width = memW * dpr; mem.height = memH * dpr;
    mem.style.width = memW + 'px'; mem.style.height = memH + 'px';
    mctx = mem.getContext('2d');
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    memFont = getComputedStyle(document.body).fontFamily;
  }

  // Assemble + load; on success rebuild the listing, on failure show errors.
  function loadProgram(text) {
    var r = ses.load(text), box = $('errors');
    box.textContent = '';
    if (r.errors.length) {
      r.errors.forEach(function (e) {
        var d = document.createElement('div');
        d.textContent = 'line ' + e.line + ': ' + e.msg;
        box.appendChild(d);
      });
      box.hidden = false;
      return r;
    }
    box.hidden = true;
    src = text;
    captions = buildCaptions(r.memSyms);
    buildListing(text);
    r.map.forEach(function (line) { if (line && lineEls[line]) lineEls[line].classList.add('code'); });
    return r;
  }

  // ---------- controls ----------
  var editing = false;

  function setEditing(on) {
    editing = on;
    var ta = $('editor');
    if (on && !ta.dataset.dirty) ta.value = src;
    $('listing').hidden = on;
    ta.hidden = !on;
    $('edit').textContent = on ? 'Listing' : 'Edit';
    $('edit').setAttribute('aria-pressed', String(on));
    if (on) ta.focus();
  }

  function reassembleAndRun() {
    var text = editing ? $('editor').value : src;
    var r = loadProgram(text);
    if (r.errors.length) return;            // keep the old program; errors are shown
    $('editor').dataset.dirty = '';
    if (editing) setEditing(false);
    ses.run();
  }

  function setSpeed(ips) {
    ses.ips = ips;
    $('speedOut').textContent = ips.toLocaleString('en-US') + ' ips';
  }

  function bindControls() {
    $('run').addEventListener('click', function () { if (ses.running) ses.pause(); else ses.run(); });
    $('step').addEventListener('click', function () { ses.stepOnce(performance.now()); });
    $('reset').addEventListener('click', function () { ses.reset(); });
    $('reasm').addEventListener('click', reassembleAndRun);
    $('edit').addEventListener('click', function () { setEditing(!editing); });
    $('editor').addEventListener('input', function () { this.dataset.dirty = '1'; });
    var sl = $('speed');
    sl.max = String(1000);
    sl.value = String(TC.UI.ipsToSlider(ses.ips));
    sl.addEventListener('input', function () { setSpeed(TC.UI.sliderToIps(+sl.value)); });
    Array.prototype.forEach.call(document.querySelectorAll('.preset'), function (btn) {
      btn.addEventListener('click', function () {
        var ips = +btn.dataset.ips;
        sl.value = String(TC.UI.ipsToSlider(ips));
        setSpeed(ips);
      });
    });
    setSpeed(ses.ips);
    // one option per embedded sample, Snake first
    Object.keys(TC.samples).sort(function (p, q) { return (p !== 'snake') - (q !== 'snake') || (p < q ? -1 : 1); })
      .forEach(function (name) {
        var o = document.createElement('option');
        o.value = name; o.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        $('sample').appendChild(o);
      });
    $('sample').addEventListener('change', function () {
      var text = TC.samples[this.value];
      if (!text) return;
      $('editor').value = text; $('editor').dataset.dirty = '';
      if (loadProgram(text).errors.length === 0) { if (editing) setEditing(false); ses.run(); }
    });
    // breakpoints: click a line number
    $('listing').addEventListener('click', function (e) {
      var no = e.target.closest('.no');
      if (!no) return;
      var line = +no.dataset.line;
      if (ses.toggleBp(line)) lineEls[line].classList.toggle('bp', !!ses.bps[line]);
    });
  }

  function drawControls() {
    var run = $('run'), label = ses.running ? 'Pause' : 'Run';
    if (run.textContent !== label) run.textContent = label;
    run.disabled = cpu.halted;
    $('step').disabled = cpu.halted;
  }

  // ---------- rendering (once per animation frame) ----------
  function drawScreen() {
    var d = img.data, v = cpu.vram;
    for (var i = 0; i < 256; i++) {
      var p = PALETTE[v[i] & 3], o = i * 4;
      d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2]; d[o + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
  }

  function drawMem(now) {
    var c = mctx, ram = cpu.ram;
    c.clearRect(0, 0, memW, memH);
    c.font = '10px ' + memFont;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#5a636b';
    for (var k = 0; k < 16; k++) {
      c.fillText(hex(k, 1), GUT_X + k * CELL_W + CELL_W / 2, GUT_Y / 2);
      c.fillText(hex(k, 1) + '0', GUT_X / 2, GUT_Y + k * CELL_H + CELL_H / 2);
    }
    for (var a = 0; a < 256; a++) {
      var x = GUT_X + (a & 15) * CELL_W, y = GUT_Y + (a >> 4) * CELL_H;
      var v = ram[a];
      c.fillStyle = v ? '#1e2327' : '#15181b';           // 00 cells sit back
      c.fillRect(x + 1, y + 1, CELL_W - 2, CELL_H - 2);
      var r = memFade(now, ses.lastRead[a], MEM_FLASH_MS), w = memFade(now, ses.lastWrite[a], MEM_FLASH_MS);
      if (r > 0) { c.fillStyle = 'rgba(77,155,255,' + (r * 0.85).toFixed(3) + ')'; c.fillRect(x + 1, y + 1, CELL_W - 2, CELL_H - 2); }
      if (w > 0) { c.fillStyle = 'rgba(255,138,61,' + (w * 0.9).toFixed(3) + ')'; c.fillRect(x + 1, y + 1, CELL_W - 2, CELL_H - 2); }
      var lit = r > 0.35 || w > 0.35;
      c.fillStyle = lit ? '#0d0f11' : (v ? '#d9dde0' : '#3b4249');
      var lbl = captions[a];
      if (lbl) {
        c.font = '8px ' + memFont;
        c.fillText(lbl, x + CELL_W / 2, y + 8, CELL_W - 4);   // squeeze 5-letter names to fit
        c.font = '10px ' + memFont;
        c.fillText(hex(v, 2), x + CELL_W / 2, y + 18);
      } else c.fillText(hex(v, 2), x + CELL_W / 2, y + CELL_H / 2 + 1);
    }
  }

  function setText(el, s) { if (el.textContent !== s) el.textContent = s; }

  function drawPanels(now) {
    var R = cpu.regs;
    for (var r = 0; r < 8; r++) {
      var v = R[r], a = fade(now, ses.regT[r], REG_FLASH_MS), rc = regCache[r], re = regEls[r];
      if (rc.v !== v) { re.hex.textContent = hex(v, 2); re.dec.textContent = String(v); rc.v = v; }
      var aq = Math.round(a * 40) / 40;
      if (rc.a !== aq) {
        re.el.style.backgroundColor = aq > 0 ? 'rgba(255,210,63,' + (aq * 0.45).toFixed(3) + ')' : '';
        re.el.classList.toggle('lit', aq > 0.25);
        rc.a = aq;
      }
    }
    setText($('pc'), '0x' + hex(cpu.pc, 3));
    setText($('sp'), '0x' + hex(cpu.sp, 2));
    var F = TC.CPU;
    $('fZ').classList.toggle('on', !!(cpu.flags & F.FZ));
    $('fC').classList.toggle('on', !!(cpu.flags & F.FC));
    $('fN').classList.toggle('on', !!(cpu.flags & F.FN));
    setText($('cycles'), cpu.cycle.toLocaleString('en-US'));
    setText($('frame'), String(cpu.ram[0xF2]));
    setText($('score'), String(cpu.ram[0xF3]));

    var b = $('banner'), cls = '', msg = '';
    if (cpu.fault) { cls = 'fault'; msg = 'Fault at PC 0x' + hex(cpu.pc, 3) + ': ' + cpu.fault; }
    else if (cpu.halted) { cls = 'halt'; msg = 'Halted at PC 0x' + hex(cpu.pc, 3) + '. Reset to start over.'; }
    else if (ses.hitLine) { cls = 'bp'; msg = 'Breakpoint, line ' + ses.hitLine + '. Run or Step to continue.'; }
    if (b.className !== cls) b.className = cls;
    setText(b, msg);

    // current source line (no animation: it changes many times per second)
    var line = ses.map[cpu.pc] || 0;
    if (line !== curLine) {
      if (lineEls[curLine]) lineEls[curLine].classList.remove('cur');
      curLine = line;
      var el = lineEls[line];
      if (el) {
        el.classList.add('cur');
        // follow the PC; while running fast, re-scroll at most every 300 ms
        if (!ses.running || ses.ips <= 2000 || now - lastScroll > 300) { scrollIntoViewIfNeeded(el); lastScroll = now; }
      }
    }
    var cur = $('cur').children, w = cpu.prog[cpu.pc];
    setText(cur[0], 'PC ' + hex(cpu.pc, 3));
    setText(cur[1], hex(w, 4));
    setText(cur[2], TC.disassemble(w));

    // trail + plain-English line: only when something new has executed
    if (ses.trailN !== shownN) {
      shownN = ses.trailN;
      var t = ses.trail(), rows = $('trail').children;
      for (var i = 0; i < 8; i++) {
        var e = t[i - (8 - t.length)];
        setText(rows[i], e ? '0x' + hex(e.pc, 3) + '  ' + TC.disassemble(e.word) : '');
      }
      var tr = cpu.trace;
      setText($('desc'), shownN ? 'Just ran 0x' + hex(tr.pc, 3) + ' ' + TC.disassemble(tr.word) + ': ' +
        describe(tr, cpu.pc, ses.info) : 'Nothing has run yet.');
    }
  }

  function scrollIntoViewIfNeeded(el) {
    var box = $('listing'), top = el.offsetTop - box.offsetTop, h = el.offsetHeight;
    if (top < box.scrollTop + h || top > box.scrollTop + box.clientHeight - 2 * h)
      box.scrollTop = top - box.clientHeight / 3;
  }

  function render(now) { drawScreen(); drawMem(now); drawPanels(now); drawControls(); }

  // ---------- input ----------
  var KEYMAP = { ArrowUp: 1, ArrowDown: 2, ArrowLeft: 3, ArrowRight: 4, w: 1, s: 2, a: 3, d: 4, W: 1, S: 2, A: 3, D: 4 };
  function onKey(e) {
    var t = document.activeElement;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
    var k = KEYMAP[e.key];
    if (!k || e.ctrlKey || e.metaKey || e.altKey) return;
    cpu.setKey(k);
    e.preventDefault();
  }

  // ---------- main loop ----------
  var last = 0;
  function tick(now) {
    var dt = last ? now - last : 0;
    last = now;
    ses.frame(dt, now);
    if ((window.devicePixelRatio || 1) !== memDpr) setupMem();   // zoom changed: stay crisp
    render(now);
    requestAnimationFrame(tick);
  }

  function boot() {
    cpu = new TC.CPU();
    ses = new Session(cpu);
    TC.UI.cpu = cpu; TC.UI.session = ses;
    scr = $('screen'); sctx = scr.getContext('2d'); img = sctx.createImageData(16, 16);
    buildRegs();
    for (var i = 0; i < 8; i++) $('trail').appendChild(document.createElement('div'));
    setupMem();
    bindControls();
    loadProgram(TC.samples.snake);
    ses.run();
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(tick);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

if (typeof module !== 'undefined') module.exports = globalThis.TC = TC; else globalThis.TC = TC;
