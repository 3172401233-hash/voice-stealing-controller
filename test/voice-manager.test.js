import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceManager, VoiceState } from '../src/voice-manager.js';

function makeManager(overrides = {}) {
  return new VoiceManager({
    budget: 4,
    protectedSlots: 1,
    hysteresis: 5,
    distanceFalloff: 0.5,
    fadeOutMs: 100,
    finishBonusWindowMs: 500,
    finishBonus: 10,
    ...overrides,
  });
}

function playingIds(result) {
  return [...result.states.entries()]
    .filter(([, state]) => state === VoiceState.PLAYING)
    .map(([id]) => id)
    .sort();
}

test('mass simultaneous triggers: budget respected, best scores play', () => {
  const vm = makeManager({ budget: 8, protectedSlots: 2 });
  for (let i = 0; i < 40; i += 1) {
    vm.declare({ id: `amb-${i}`, category: 'ambient', priority: i % 10, distance: i });
  }
  for (let i = 0; i < 20; i += 1) {
    vm.declare({ id: `step-${i}`, category: 'footstep', priority: 1, distance: 5 });
  }
  vm.declare({ id: 'boss-line', category: 'dialogue', priority: 50, distance: 0 });
  vm.declare({ id: 'boss-line-2', category: 'dialogue', priority: 45, distance: 0 });

  const result = vm.update(0);
  const playing = playingIds(result);
  assert.equal(playing.length, 8);
  assert.ok(playing.includes('boss-line'));
  assert.ok(playing.includes('boss-line-2'));
  assert.ok(!playing.some((id) => id.startsWith('step-')));

  const again = vm.update(16);
  assert.deepEqual(playingIds(again), playing);
  assert.equal(again.fadePlan.length, 0);
});

test('budget shrink returns fade plan and target states only', () => {
  const vm = makeManager({ budget: 4, protectedSlots: 0 });
  for (let i = 0; i < 4; i += 1) {
    vm.declare({ id: `v${i}`, priority: 100 - i * 20, distance: 0 });
  }
  vm.update(0);
  assert.equal(playingIds(vm.update(1)).length, 4);

  vm.setBudget(2);
  const shrunk = vm.update(10);
  assert.equal(shrunk.fadePlan.length, 2);
  assert.deepEqual(
    shrunk.fadePlan.map((f) => f.id).sort(),
    ['v2', 'v3'],
  );
  assert.ok(shrunk.fadePlan.every((f) => f.fadeOutMs === 100 && f.startAt === 10));
  assert.equal(shrunk.states.get('v2'), VoiceState.FADING);
  assert.equal(shrunk.targets.get('v2'), VoiceState.VIRTUAL);
  assert.deepEqual(playingIds(shrunk), ['v0', 'v1']);

  const afterFade = vm.update(200);
  assert.equal(afterFade.states.get('v2'), VoiceState.VIRTUAL);
  assert.equal(afterFade.states.get('v3'), VoiceState.VIRTUAL);
});

test('budget recovery re-evaluates virtual voices instead of FIFO', () => {
  const vm = makeManager({ budget: 2, protectedSlots: 0, hysteresis: 5 });
  vm.declare({ id: 'a', priority: 90 });
  vm.declare({ id: 'b', priority: 80 });
  vm.update(0);

  vm.declare({ id: 'c', priority: 70 });
  vm.declare({ id: 'd', priority: 85 });
  vm.update(10);
  const settled = vm.update(200);
  assert.equal(settled.states.get('c'), VoiceState.VIRTUAL);
  assert.equal(settled.states.get('d'), VoiceState.VIRTUAL);

  vm.setBudget(3);
  const grown = vm.update(300);
  assert.ok(grown.resumed.includes('d'));
  assert.ok(!grown.resumed.includes('c'));
  assert.equal(grown.states.get('c'), VoiceState.VIRTUAL);
});

test('equal priorities do not flap across frames', () => {
  const vm = makeManager({ budget: 2, protectedSlots: 0, hysteresis: 5 });
  vm.declare({ id: 'x', priority: 10 });
  vm.declare({ id: 'y', priority: 10 });
  vm.declare({ id: 'z', priority: 10 });
  const first = playingIds(vm.update(0));
  assert.equal(first.length, 2);
  for (let t = 1; t <= 20; t += 1) {
    const result = vm.update(t * 16);
    assert.deepEqual(playingIds(result), first);
    assert.equal(result.fadePlan.length, 0);
  }
});

test('hysteresis blocks marginal challengers but allows clear winners', () => {
  const vm = makeManager({ budget: 1, protectedSlots: 0, hysteresis: 5 });
  vm.declare({ id: 'incumbent', priority: 50 });
  vm.update(0);

  vm.declare({ id: 'close', priority: 54 });
  let result = vm.update(16);
  assert.equal(result.states.get('incumbent'), VoiceState.PLAYING);
  assert.equal(result.states.get('close'), VoiceState.VIRTUAL);

  vm.declare({ id: 'clear', priority: 60 });
  result = vm.update(32);
  assert.equal(result.states.get('clear'), VoiceState.PLAYING);
  assert.equal(result.states.get('incumbent'), VoiceState.FADING);
});

test('distance attenuates effective priority', () => {
  const vm = makeManager({ budget: 1, protectedSlots: 0, hysteresis: 0 });
  vm.declare({ id: 'near', priority: 20, distance: 0 });
  vm.declare({ id: 'far', priority: 40, distance: 100 });
  const result = vm.update(0);
  assert.equal(result.states.get('near'), VoiceState.PLAYING);
  assert.equal(result.states.get('far'), VoiceState.VIRTUAL);
});

test('long audio near completion is protected by finish bonus', () => {
  const vm = makeManager({ budget: 1, protectedSlots: 0, hysteresis: 5 });
  vm.declare({ id: 'long', priority: 10, duration: 30000, elapsed: 29600 });
  vm.update(0);

  vm.declare({ id: 'challenger', priority: 18, duration: 1000, elapsed: 0 });
  const result = vm.update(16);
  assert.equal(result.states.get('long'), VoiceState.PLAYING);
  assert.equal(result.states.get('challenger'), VoiceState.VIRTUAL);

  vm.updateVoice('long', { elapsed: 30000 });
  vm.updateVoice('challenger', { priority: 18 });
  const finished = vm.update(32);
  assert.equal(finished.states.get('long'), VoiceState.PLAYING);
});

test('dialogue keeps protected slots and cannot be stolen by sfx', () => {
  const vm = makeManager({ budget: 3, protectedSlots: 2, hysteresis: 5 });
  vm.declare({ id: 'line', category: 'dialogue', priority: 1 });
  for (let i = 0; i < 5; i += 1) {
    vm.declare({ id: `boom-${i}`, category: 'sfx', priority: 100 });
  }
  const result = vm.update(0);
  assert.equal(result.states.get('line'), VoiceState.PLAYING);
  assert.equal(playingIds(result).length, 3);

  vm.declare({ id: 'hint', category: 'critical', priority: 1 });
  const withHint = vm.update(16);
  assert.equal(withHint.states.get('hint'), VoiceState.PLAYING);
  assert.equal(playingIds(withHint).filter((id) => id.startsWith('boom-')).length, 1);
});

test('dialogue reclaims reserved slot immediately without hysteresis', () => {
  const vm = makeManager({ budget: 2, protectedSlots: 1, hysteresis: 50 });
  vm.declare({ id: 'music', category: 'music', priority: 80 });
  vm.declare({ id: 'amb', category: 'ambient', priority: 70 });
  vm.update(0);
  assert.equal(vm.update(1).states.get('music'), VoiceState.PLAYING);

  vm.declare({ id: 'line', category: 'dialogue', priority: 1 });
  const result = vm.update(16);
  assert.equal(result.states.get('line'), VoiceState.PLAYING);
  assert.equal(result.states.get('amb'), VoiceState.FADING);
  assert.equal(result.states.get('music'), VoiceState.PLAYING);
});

test('fast disappearing voices leave no residue', () => {
  const vm = makeManager({ budget: 2, protectedSlots: 0 });
  vm.declare({ id: 'blink', priority: 100 });
  vm.remove('blink');
  const result = vm.update(0);
  assert.equal(result.states.size, 0);
  assert.equal(result.fadePlan.length, 0);

  vm.declare({ id: 'fader', priority: 10 });
  vm.declare({ id: 'other', priority: 90 });
  vm.update(10);
  assert.equal(vm.update(11).states.get('fader'), VoiceState.PLAYING);
  vm.declare({ id: 'third', priority: 80 });
  vm.update(12);
  assert.equal(vm.update(13).states.get('fader'), VoiceState.FADING);
  vm.remove('fader');
  const after = vm.update(14);
  assert.equal(after.states.has('fader'), false);
  assert.deepEqual(playingIds(after), ['other', 'third']);
});

test('declaration order does not change the playing set', () => {
  const declarations = [
    { id: 'a', priority: 10 },
    { id: 'b', priority: 10 },
    { id: 'c', priority: 10 },
    { id: 'd', priority: 10 },
  ];
  const run = (list) => {
    const vm = makeManager({ budget: 2, protectedSlots: 0 });
    for (const d of list) vm.declare(d);
    return playingIds(vm.update(0));
  };
  const forward = run(declarations);
  const reversed = run([...declarations].reverse());
  assert.equal(forward.length, 2);
  assert.equal(reversed.length, 2);

  const vm = makeManager({ budget: 2, protectedSlots: 0 });
  for (const d of declarations) vm.declare(d);
  const stable = playingIds(vm.update(0));
  vm.remove('a');
  vm.declare({ id: 'a', priority: 10 });
  const after = vm.update(16);
  assert.equal(after.states.get('a'), VoiceState.VIRTUAL);
  assert.deepEqual(playingIds(after), ['b', 'c']);
});

test('fading voice can be re-acquired when budget returns before fade ends', () => {
  const vm = makeManager({ budget: 1, protectedSlots: 0, hysteresis: 0, fadeOutMs: 500 });
  vm.declare({ id: 'keeper', priority: 50 });
  vm.update(0);
  vm.declare({ id: 'intruder', priority: 90 });
  const stolen = vm.update(10);
  assert.equal(stolen.states.get('keeper'), VoiceState.FADING);

  vm.remove('intruder');
  const restored = vm.update(20);
  assert.equal(restored.states.get('keeper'), VoiceState.PLAYING);
  assert.ok(restored.resumed.includes('keeper'));
});

test('virtual voice resumes when a slot frees and scores allow', () => {
  const vm = makeManager({ budget: 2, protectedSlots: 0, hysteresis: 5 });
  vm.declare({ id: 'p1', priority: 50 });
  vm.declare({ id: 'p2', priority: 40 });
  vm.declare({ id: 'waiting', priority: 38 });
  vm.update(0);
  assert.equal(vm.update(1).states.get('waiting'), VoiceState.VIRTUAL);

  vm.remove('p1');
  const result = vm.update(16);
  assert.equal(result.states.get('waiting'), VoiceState.PLAYING);
  assert.ok(result.resumed.includes('waiting'));
});
