// A tiny test harness so the suite runs in a browser page (scripts/test.sh) without Node.

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export async function run() {
  const lines = [];
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      lines.push(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      lines.push(`FAIL ${name}\n     ${error.message}`);
    }
  }
  lines.push('', failed ? `${failed} of ${tests.length} FAILED` : `ALL PASSED (${tests.length} tests)`);
  return { failed, report: lines.join('\n') };
}

export function equal(actual, expected, label = 'value') {
  if (!isDeepEqual(actual, expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function ok(value, label = 'expected a truthy value') {
  if (!value) throw new Error(label);
}

function isDeepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => isDeepEqual(a[key], b[key]));
}
