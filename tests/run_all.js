// Runs every tests/*.test.js in a fresh node process; exits non-zero on any failure.
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var dir = __dirname;
var files = fs.readdirSync(dir).filter(function (f) { return /\.test\.js$/.test(f); }).sort();
var failed = 0;
files.forEach(function (f) {
  var r = cp.spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  var ok = r.status === 0;
  if (!ok) failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + f);
  if (!ok) process.stdout.write((r.stdout || '') + (r.stderr || ''));
});
console.log(files.length - failed + '/' + files.length + ' test files passed');
process.exit(failed ? 1 : 0);
