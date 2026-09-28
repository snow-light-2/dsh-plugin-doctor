import { test } from 'node:test';
import assert from 'node:assert/strict';

import { satisfies, parseVersion, compareVersions } from '../src/semver.js';

test('parseVersion splits prerelease', () => {
  assert.deepEqual(parseVersion('0.1.2-rc.1'), { major: 0, minor: 1, patch: 2, prerelease: ['rc', '1'] });
  assert.equal(parseVersion('not-a-version'), null);
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
});

test('compareVersions orders prereleases before releases', () => {
  assert.equal(compareVersions('0.1.2', '0.1.2'), 0);
  assert.equal(compareVersions('0.1.2-rc.1', '0.1.2'), -1);
  assert.equal(compareVersions('0.1.2', '0.1.3'), -1);
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.2-rc.1', '0.1.2-rc.2'), -1);
});

test('satisfies handles the ranges plugins actually declare', () => {
  assert.equal(satisfies('0.1.2-rc.1', '>=0.1.5-rc.1'), false);
  assert.equal(satisfies('0.1.6-rc.1', '>=0.1.5-rc.1'), true);
  assert.equal(satisfies('0.1.2-rc.1', '>=0.1.2-rc.1'), true);
  assert.equal(satisfies('0.1.2-rc.1', '>=0.1.2'), false);
  assert.equal(satisfies('0.1.2', '>=0.1.2'), true);
  assert.equal(satisfies('1.0.0', '^1.0.0'), true);
  assert.equal(satisfies('2.0.0', '^1.0.0'), false);
  assert.equal(satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(satisfies('3.1.0', '>=2 <4'), true);
  assert.equal(satisfies('4.0.0', '>=2 <4'), false);
  assert.equal(satisfies('1.0.0', '^1 || ^2'), true);
  assert.equal(satisfies('2.5.0', '^1 || ^2'), true);
  assert.equal(satisfies('3.0.0', '^1 || ^2'), false);
  assert.equal(satisfies('0.1.2', '*'), true);
  assert.equal(satisfies('0.1.2', ''), true);
});

test('satisfies reports unknown instead of guessing', () => {
  assert.equal(satisfies('0.1.2', 'workspace:^'), undefined);
  assert.equal(satisfies('garbage', '>=1.0.0'), undefined);
});

test('^0.x is narrower than ^1.x, as npm defines it', () => {
  assert.equal(satisfies('0.1.9', '^0.1.2'), true);
  assert.equal(satisfies('0.2.0', '^0.1.2'), false);
  assert.equal(satisfies('0.0.3', '^0.0.2'), false);
});
