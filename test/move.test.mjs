// Checks who may hand saved things over to this copy of Weftday, and what is accepted (public/movein.js).
// Run:  node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { trusted, mayReceive, checkItems, checkRecording, KEYS } from '../public/movein.js';

const published = { hostname: 'app.weftday.crckd.live', origin: 'https://app.weftday.crckd.live' };
const onThisComputer = { hostname: 'localhost', origin: 'http://localhost:4399' };

test('only the old address may hand things to the published app', () => {
  assert.equal(trusted('https://crckdteam.github.io', published), true);
  for (const other of ['https://evil.example', 'http://crckdteam.github.io', 'https://crckdteam.github.io.evil.example', 'https://x.github.io',
    'http://localhost:4396', 'http://127.0.0.1:80', 'null', '', 'https://app.weftday.crckd.live', 'https://weftday.crckd.live']) {
    assert.equal(trusted(other, published), false, other);
  }
});
test('a copy being tried on this computer also takes from this computer, and from nowhere else', () => {
  assert.equal(trusted('http://localhost:4396', onThisComputer), true);
  assert.equal(trusted('http://127.0.0.1:9', onThisComputer), true);
  assert.equal(trusted('https://evil.example', onThisComputer), false);
  assert.equal(trusted('http://localhost.evil.example', onThisComputer), false);
});
test('only the published app and a copy on this computer take things in', () => {
  assert.equal(mayReceive(published), true);
  assert.equal(mayReceive(onThisComputer), true);
  assert.equal(mayReceive({ hostname: 'someone.example', origin: 'https://someone.example' }), false);
  assert.equal(mayReceive({ hostname: 'crckdteam.github.io', origin: 'https://crckdteam.github.io' }), false);
});
test('saved things are taken only under the names the app uses, and only as text', () => {
  const good = { 'planner.v1': JSON.stringify({ settings: {}, tasks: [] }), 'weftday.toured': '1', 'somebody.else': 'x', __proto__: { polluted: 'y' } };
  assert.deepEqual(Object.keys(checkItems(good)).sort(), ['planner.v1', 'weftday.toured']);
  assert.ok(KEYS.includes('planner.v1'));
  assert.throws(() => checkItems(null));
  assert.throws(() => checkItems([]));
  assert.throws(() => checkItems({ 'planner.v1': { settings: {} } }), 'an object where text belongs');
  assert.throws(() => checkItems({ 'planner.v1': 'not json' }));
  assert.throws(() => checkItems({ 'planner.v1': '[1,2]' }));
  assert.throws(() => checkItems({ 'planner.v1': '{"settings":"x"}' }));
  assert.deepEqual(checkItems({}), {});
});
test('a recording must look like one', () => {
  assert.ok(checkRecording('rec', { id: 'abc', at: 1 }));
  assert.ok(checkRecording('part', { id: 'abc', kind: 'm', n: 0, blob: new Blob(['x']) }));
  assert.throws(() => checkRecording('rec', { id: '' }));
  assert.throws(() => checkRecording('rec', { id: 5 }));
  assert.throws(() => checkRecording('part', { id: 'abc', kind: 'z', n: 0, blob: new Blob(['x']) }));
  assert.throws(() => checkRecording('part', { id: 'abc', kind: 'm', n: 0, blob: 'text' }));
  assert.throws(() => checkRecording('part', { id: 'abc', kind: 'm', n: -1, blob: new Blob(['x']) }));
});
