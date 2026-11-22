var assert = require('assert');
var G = require('./game_util.js');
var asm = G.loadGame('dodge'), S = asm.symbols;

function greens(c) { var out = []; for (var i = 0; i < 256; i++) if (c.vram[i] === 1) out.push(i); return out; }

// start: only the white player, mid bottom row
var c = G.boot(asm);
assert.strictEqual(c.vram[S.BOTTOM + 7], 3);
assert.strictEqual(G.count(c, 3), 1); assert.strictEqual(G.count(c, 1), 0);
assert.strictEqual(c.ram[0xF3], 0);

// a block spawns in row 0 after SPAWN_STEPS steps
for (var i = 0; i < S.SPAWN_STEPS; i++) G.step(c, asm);
var g = greens(c);
assert.strictEqual(g.length, 1, 'one block'); assert.ok(g[0] < 16, 'in row 0');

// it falls one row per step
var p = g[0];
G.step(c, asm);
assert.ok(c.vram[p + 16] === 1 && c.vram[p] === 0, 'fell one row');
G.step(c, asm);
assert.strictEqual(c.vram[p + 32], 1);

// player moves with keys 3/4 and is clamped to the screen
c.setKey(4); G.runUntil(c, function () { return c.ram[S.PX] === 8; }, 2000); c.run(50);
assert.strictEqual(c.vram[S.BOTTOM + 8], 3); assert.strictEqual(c.vram[S.BOTTOM + 7], 0);
c.ram[S.PX] = 0; c.vram[S.BOTTOM + 8] = 0; c.vram[S.BOTTOM] = 3;
c.setKey(3); c.run(200);
assert.strictEqual(c.ram[S.PX], 0, 'clamped at left edge');
c.ram[S.PX] = 15; c.vram[S.BOTTOM] = 0; c.vram[S.BOTTOM + 15] = 3;
c.setKey(4); c.run(200);
assert.strictEqual(c.ram[S.PX], 15, 'clamped at right edge');

// a block falling past the bottom scores 1 (and frees its slot)
function placeBlock(c, slot, x, y) {
  c.ram[S.BX + slot] = x; c.ram[S.BY + slot] = y; c.vram[y * 16 + x] = 1;
}
c = G.boot(asm);
placeBlock(c, 0, 3, 15);                 // player is at x = 7
G.step(c, asm);
assert.strictEqual(c.ram[0xF3], 1, 'score on a miss');
assert.strictEqual(c.ram[S.BY], S.FREE);
assert.strictEqual(c.vram[S.BOTTOM + 3], 0);

// speed steps up every 8 points
assert.strictEqual(c.ram[S.PERIOD], S.STEP_FRAMES);
c.ram[0xF3] = 7; placeBlock(c, 0, 3, 15); G.step(c, asm);
assert.strictEqual(c.ram[0xF3], 8); assert.strictEqual(c.ram[S.PERIOD], S.STEP_FRAMES - 1);
c.ram[0xF3] = 200; placeBlock(c, 0, 3, 15); G.step(c, asm);
assert.strictEqual(c.ram[S.PERIOD], 1, 'never below 1 frame');

// at most 4 blocks at once
c = G.boot(asm);
for (i = 0; i < 4; i++) placeBlock(c, i, i, 2);
c.ram[S.SPAWN] = 1; G.step(c, asm);
assert.strictEqual(greens(c).length, 4, 'no 5th block');

// a block landing on the player ends the game (screen fills red)
c = G.boot(asm);
placeBlock(c, 0, 7, 14);
assert.ok(G.runUntil(c, function () { return G.allRed(c); }, 100000), 'collision -> red');
c.run(5000); assert.ok(G.allRed(c), 'waits for a key');

// any key restarts
c.setKey(1);
assert.ok(G.runUntil(c, function () { return c.pc === S.MAIN && c.rsp === 0; }, 10000), 'restarted');
assert.strictEqual(G.count(c, 3), 1); assert.strictEqual(G.count(c, 2), 0); assert.strictEqual(c.ram[0xF3], 0);

// moving into a block on the bottom row also ends the game
c = G.boot(asm);
placeBlock(c, 0, 8, 15);
c.setKey(4);
assert.ok(G.runUntil(c, function () { return G.allRed(c); }, 5000), 'walk into block -> red');

console.log('dodge tests ok (' + asm.words.length + ' words)');
