// Pure parts of the world API, with stubs: roles, guards, locked rooms, snapshot round trip, curse timers.
import assert from 'node:assert/strict';
import { createWorldAPI } from '../src/world/api.js';

const mk = (authority = true) => {
	const dungeon = { W: 40, H: 40, rooms: [0, 1, 2, 3].map((id) => ({ id, cx: id * 5, cy: 3, type: id === 0 ? 'entrance' : id === 3 ? 'boss' : 'combat' })) };
	const R = { hp: 50, maxHp: 100, mana: 10, maxMana: 100, potions: 0, xp: 0 };
	const said = [];
	const cues = [];
	const flashes = [];
	const view = { look: { exposure: 1, fog: 1, fogMix: 0, fogColor: { r: 0, g: 0, b: 0 } }, POST: { fin: { uniforms: { uGrade: { value: { r: 1, g: 1, b: 1 } } } } }, applyPalette() {} };
	const fx = { flashLight: (x, y, z, c, peak, dur, follow) => { const s = { peak, life: dur, max: dur, follow }; flashes.push(s); return s; } };
	const audio = { cue: (n) => cues.push(n), music() {} };
	const w = createWorldAPI({ view, dungeon, enemies: {}, fx, audio, hud: { say: (t) => said.push(t) }, R, authority, quests: { add() {} } });
	return { w, dungeon, R, said, cues, view, flashes };
};

{
	const { w, dungeon } = mk();
	w.role(1, 'treasure'); w.role(0, 'combat'); w.role(3, 'shrine'); w.role(2, 'boss');
	assert.equal(dungeon.rooms[1].type, 'treasure');
	assert.equal(dungeon.rooms[0].type, 'entrance');
	assert.equal(dungeon.rooms[3].type, 'boss');
	assert.equal(dungeon.rooms[2].type, 'combat');
	w.guard(2, 'ogre', 3, 1); w.guard(3, 'hollow', 2);
	assert.deepEqual(dungeon.rooms[2].roster, [{ enemy: 'ogre', n: 3, level: 1 }]);
	assert.equal(dungeon.rooms[3].roster, undefined);
}
{
	const { w, dungeon } = mk(false);
	w.role(1, 'treasure'); w.guard(1, 'ogre', 1); w.bless('heal', 50); w.seal(1);
	assert.equal(dungeon.rooms[1].type, 'combat');
	assert.equal(dungeon.rooms[1].roster, undefined);
	assert.equal(w.sealed.size, 0);
}
{
	const { w, R, view, cues, flashes } = mk();
	w.bless('heal', 30); w.bless('mana', 20); w.bless('potion', 50); w.bless('xp', 10); w.bless('haste', 20);
	assert.deepEqual([R.hp, R.mana, R.potions, R.xp], [80, 30, 2, 10]);
	assert.equal(w.mods.speed, 1.35);
	w.curse('slow', 5); w.curse('frenzy', 4); w.curse('poison', 6);
	assert.equal(w.mods.speed, 1.35 * 0.7);
	assert.equal(w.mods.enemySpeed, 1.35);
	const hp = R.hp;
	for (let i = 0; i < 60; i++) w.update(0.1);
	assert.ok(R.hp < hp && R.hp >= 1, 'poison drains');
	assert.equal(w.timers.slow, 0);
	assert.equal(w.mods.enemySpeed, 1);
	w.curse('dark', 10); w.mood('wrath'); w.light(1, 'ember', 2); w.seal(2); w.role(2, 'shrine'); w.music('dread'); w.sfx('bell', 1);
	for (let i = 0; i < 80; i++) w.update(0.1);
	assert.ok(view.look.exposure < 0.9 && view.look.fog > 2, 'mood eases in');
	assert.ok(flashes[0].peak > 10, 'light fades in');
	assert.ok(cues.includes('bell'));
	const snap = w.snapshot();
	const json = JSON.stringify(snap);
	assert.ok(json.length < 4096, `snapshot ${json.length} bytes`);
	const b = mk(false);
	b.w.restore(JSON.parse(json));
	assert.deepEqual(b.w.snapshot(), snap);
	assert.equal(b.dungeon.rooms[2].type, 'shrine');
	assert.ok(b.w.isSealed(2));
}
console.log('worldtest ok');
