var assert = require('assert');
var G = require('./game_util.js');
var asm = G.loadGame('pong'), S = asm.symbols;

function at(c, x, y) { return c.vram[y * 16 + x]; }
// Put the ball somewhere (keeping VRAM consistent) with a direction.
function setBall(c, x, y, dx, dy) {
  c.vram[c.ram[S.BALLY] * 16 + c.ram[S.BALLX]] = 0;
  c.ram[S.BALLX] = x; c.ram[S.BALLY] = y; c.ram[S.DX] = dx & 0xFF; c.ram[S.DY] = dy & 0xFF;
  c.vram[y * 16 + x] = 1;
}
function setPaddle(c, which, top) {
  var x = which === S.PY ? 0 : 15, color = which === S.PY ? 3 : 2;
  for (var y = 0; y < 16; y++) c.vram[y * 16 + x] = 0;
  c.ram[which] = top;
  for (y = top; y < top + 3; y++) c.vram[y * 16 + x] = color;
}

// start: two 3-pixel paddles and a ball at the center
var c = G.boot(asm);
assert.strictEqual(G.count(c, 3), 3); assert.strictEqual(G.count(c, 2), 3); assert.strictEqual(G.count(c, 1), 1);
assert.strictEqual(at(c, 0, 6), 3); assert.strictEqual(at(c, 15, 8), 2); assert.strictEqual(at(c, 7, 7), 1);
assert.strictEqual(c.ram[S.DX], 0xFF, 'serves toward the player');

// ball moves one cell diagonally per step
setBall(c, 5, 5, 1, 1); G.step(c, asm);
assert.strictEqual(at(c, 6, 6), 1); assert.strictEqual(at(c, 5, 5), 0);

// wall bounce flips the vertical direction
setBall(c, 5, 0, 1, -1); G.step(c, asm);
assert.strictEqual(c.ram[S.DY], 1, 'top wall'); assert.strictEqual(at(c, 6, 1), 1);
setBall(c, 5, 15, 1, 1); G.step(c, asm);
assert.strictEqual(c.ram[S.DY], 0xFF, 'bottom wall'); assert.strictEqual(at(c, 6, 14), 1);

// paddle hit flips the horizontal direction
c = G.boot(asm);
setPaddle(c, S.PY, 6);                       // covers rows 6..8
setBall(c, 1, 7, -1, 1); G.step(c, asm);     // heading for (0, 8): white
assert.strictEqual(c.ram[S.DX], 1, 'player paddle bounce');
assert.strictEqual(at(c, 2, 8), 1); assert.strictEqual(c.ram[0xF3], 0);
setPaddle(c, S.AY, 3);
setBall(c, 14, 3, 1, 1); G.step(c, asm);     // AI paddle covers (15, 4)
assert.strictEqual(c.ram[S.DX], 0xFF, 'AI paddle bounce');

// AI: only reacts on its half, one pixel per step toward the ball
c = G.boot(asm);
setPaddle(c, S.AY, 6);
setBall(c, 4, 1, 1, 1); G.step(c, asm);
assert.strictEqual(c.ram[S.AY], 6, 'ball on left half: AI waits');
setBall(c, 9, 1, 1, 1); G.step(c, asm);
assert.strictEqual(c.ram[S.AY], 5, 'moves up one pixel');
assert.strictEqual(G.count(c, 2), 3, 'paddle still 3 pixels');
setPaddle(c, S.AY, 13);
setBall(c, 9, 14, 1, 1); G.step(c, asm);
assert.strictEqual(c.ram[S.AY], 13, 'stays on screen at the bottom');

// AI miss: SCORE +1, ball respawns at the center
c = G.boot(asm);
setPaddle(c, S.AY, 12);                      // far from the ball: can't reach in one step
setBall(c, 14, 2, 1, -1); G.step(c, asm);
assert.strictEqual(c.ram[0xF3], 1, 'score when the AI misses');
assert.strictEqual(c.ram[S.BALLX], 7); assert.strictEqual(c.ram[S.BALLY], 7);
assert.ok(c.ram[S.DY] === 1 || c.ram[S.DY] === 0xFF);
assert.strictEqual(G.count(c, 1), 1, 'exactly one ball');

// player miss: screen flashes red, no score, ball respawns at the center
c = G.boot(asm);
setPaddle(c, S.PY, 10);
setBall(c, 1, 2, -1, -1);
assert.ok(G.runUntil(c, function () { return G.allRed(c); }, 100000), 'flash on player miss');
G.runUntil(c, function () { return c.pc === S.MAIN && c.rsp === 0; }, 100000);
assert.strictEqual(c.ram[0xF3], 0, 'no score');
assert.strictEqual(G.count(c, 2), 3, 'field redrawn');
assert.strictEqual(at(c, 7, 7), 1); assert.strictEqual(c.ram[S.BALLX], 7);

// player paddle: keys 1/2 move it, clamped to the screen
c = G.boot(asm);
c.setKey(1); G.runUntil(c, function () { return c.ram[S.PY] === 5; }, 2000); c.run(50);
assert.strictEqual(at(c, 0, 5), 3); assert.strictEqual(at(c, 0, 8), 0);
c.setKey(2); G.runUntil(c, function () { return c.ram[S.PY] === 6; }, 2000);
setPaddle(c, S.PY, 0); c.setKey(1); c.run(300); assert.strictEqual(c.ram[S.PY], 0, 'top clamp');
setPaddle(c, S.PY, 13); c.setKey(2); c.run(300); assert.strictEqual(c.ram[S.PY], 13, 'bottom clamp');

// a long rally never faults or loses the ball
c = G.boot(asm);
c.run(3000000);
assert.strictEqual(c.fault, null); assert.ok(G.count(c, 1) <= 1);

console.log('pong tests ok (' + asm.words.length + ' words)');
