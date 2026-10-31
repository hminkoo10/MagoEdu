'use strict';

function parseVersion(v) {
  const nums = String(v || '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .slice(0, 4)
    .map(Number);
  while (nums.length < 3) nums.push(0);
  return nums;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

module.exports = { parseVersion, compareVersions };
