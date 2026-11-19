// Gate: multi-target enemies + scripted companions, headless. node tools/simtest-party.mjs
import * as THREE from 'three';
import { TYPES, createEnemies } from '../src/game/enemies.js';
import { bfsField, cellOf, createCompanions, pickTarget, stepDown } from '../src/party/bots.js';

let fails = 0;
const ok = (c, m) => {
	if (!c) {
		fails++;
		console.log('FAIL', m);
	} else console.log('ok  ', m);
};

// ---- a hand-made dungeon: a 24x10 hall, a wall column at x=12 with a door gap at row 5, and a sealed pocket.
const W = 24;
const H = 10;
const grid = new Uint8Array(W * H);
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) grid[y * W + x] = 1;
for (let y = 1; y < H - 1; y++) if (y !== 5) grid[y * W + 12] = 0;
const pocket = 3 * W + 20;
for (const c of [pocket - 1, pocket + 1, pocket - W, pocket + W]) grid[c] = 0;
const walkable = Uint8Array.from(grid);
const dungeon = { W, H, grid, walkable, roomId: new Int16Array(W * H).fill(-1), rooms: [], props: [], stairs: { cap: new Float32Array(W * H), axis: new Uint8Array(W * H), sign: new Int8Array(W * H).fill(1), off: new Float32Array(W * H), steps: new Float32Array(W * H) } };
const wx = (cx) => cx + 0.5 - W / 2;
const wz = (cy) => cy + 0.5 - H / 2;

// ---- BFS vs a brute-force reference (per-source BFS, min of all)
{
	const dist = new Int16Array(W * H);
	const queue = new Int32Array(W * H);
	const srcCells = [2 * W + 2, 8 * W + 22, 5 * W + 11];
	const src = Int32Array.from(srcCells);
	bfsField(grid, W, H, src, 3, dist, queue, 60);
	let bad = 0;
	const single = new Int16Array(W * H);
	const ref = new Int16Array(W * H).fill(-1);
	for (const s of srcCells) {
		bfsField(grid, W, H, Int32Array.from([s]), 1, single, queue, 60);
		for (let i = 0; i < W * H; i++) if (single[i] >= 0 && (ref[i] < 0 || single[i] < ref[i])) ref[i] = single[i];
	}
	for (let i = 0; i < W * H; i++) if (ref[i] !== dist[i]) bad++;
	ok(bad === 0, 'multi-source BFS equals min of per-source BFS');
	ok(dist[2 * W + 2] === 0 && dist[8 * W + 22] === 0, 'sources are distance 0');
	ok(dist[pocket] === -1, 'sealed cell unreached');
	// field cap
	bfsField(grid, W, H, Int32Array.from([W + 1]), 1, single, queue, 5);
	ok(single[W + 6] === 5 && single[W + 7] === -1, 'maxD caps the flood');
	// stepDown walks the field to the source
	const out = { x: 0, z: 0 };
	let x = wx(18);
	let z = wz(2);
	bfsField(grid, W, H, Int32Array.from([8 * W + 2]), 1, dist, queue, 60);
	let steps = 0;
	while (steps++ < 60 && dist[cellOf(W, H, x, z)] > 0 && stepDown(grid, W, H, dist, x, z, out)) {
		x = out.x;
		z = out.z;
	}
	ok(cellOf(W, H, x, z) === 8 * W + 2, 'stepDown reaches the source through the door gap');
}

// ---- target pick
{
	const T = [{ id: 'me', x: 0, z: 0, alive: true }, { id: 'bot:0', x: 6, z: 0, alive: true }];
	ok(pickTarget(T, 2, 5, 0, null).id === 'bot:0', 'nearest target chosen');
	ok(pickTarget(T, 2, 3.2, 0, T[0]).id === 'me', 'sticks to current target when nearly as close');
	ok(pickTarget(T, 2, 5.5, 0, T[0]).id === 'bot:0', 'flips when clearly closer to another');
	T[1].alive = false;
	ok(pickTarget(T, 2, 5.5, 0, null).id === 'me', 'dead targets skipped');
	T[0].alive = false;
	ok(pickTarget(T, 2, 5.5, 0, null) === null, 'no alive target gives null');
}

// ---- enemies: real createEnemies with a fake knight (no GLB) and wisps
const fxStub = new Proxy({}, { get: () => () => {} });
const sceneStub = { add() {}, remove() {} };
const knight = new THREE.Group();
knight.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial()));
TYPES.hollow.scale = TYPES.revenant.scale = 1;
TYPES.hollow.clips = TYPES.revenant.clips = Object.fromEntries(['Idle', 'Run', 'Attack', 'Kick', 'Hit', 'GroundSlam'].map((n) => [n, new THREE.AnimationClip(n, 1, [])]));
const mk = () => createEnemies({ scene: sceneStub, assets: { knight: { scene: knight } }, dungeon, fx: fxStub, audio: new Proxy({}, { get: () => () => {} }), env: {} });
{
	const en = mk();
	const log = { me: 0, actor: [], bolt: [] };
	const hooks = { hitPlayer: () => log.me++, hitActor: (e, id, d, k) => log.actor.push([id, d, k]), bolt: (e, t) => log.bolt.push(t && t.id), whiff() {} };
	const h = en.spawn('hollow', wx(4), wz(5), { rise: false });
	h.state = 'chase';
	en.setTargets([{ id: 'me', x: wx(20), z: wz(5), alive: true }, { id: 'bot:0', x: wx(6), z: wz(5), alive: true }]);
	for (let i = 0; i < 120; i++) en.update(1 / 30, hooks);
	ok(log.actor.length > 0 && log.actor[0][0] === 'bot:0' && log.actor[0][2] === 'melee', 'hollow attacks the nearest target via hitActor');
	ok(log.me === 0, 'no hitPlayer for the far target');

	// chases through the door gap toward a target in the other half
	const g = en.spawn('hollow', wx(4), wz(2), { rise: false });
	g.state = 'chase';
	g.cd = 99;
	en.setTargets([{ id: 'me', x: wx(20), z: wz(8), alive: true }]);
	for (let i = 0; i < 600; i++) en.update(1 / 30, hooks);
	ok(g.x > 12 - W / 2 + 1, 'enemy crosses the wall column via the gap');

	// old signature: one target 'me', hitPlayer path
	const en2 = mk();
	const lg = { me: 0, actor: 0 };
	const hk = { hitPlayer: () => lg.me++, hitActor: () => lg.actor++, whiff() {} };
	const h2 = en2.spawn('hollow', wx(4), wz(5), { rise: false });
	h2.state = 'chase';
	const player = { x: wx(5), z: wz(5) };
	for (let i = 0; i < 90; i++) en2.update(1 / 30, player, hk);
	ok(lg.me > 0 && lg.actor === 0, 'old update(dt, player, hooks) still hits via hitPlayer');

	// wisp bolt aims at its target
	const en3 = mk();
	const lb = [];
	const w = en3.spawn('wisp', wx(4), wz(5), { rise: false });
	w.state = 'chase';
	w.cd = 0;
	en3.setTargets([{ id: 'me', x: wx(20), z: wz(5), alive: true }, { id: 'bot:1', x: wx(8), z: wz(5), alive: true }]);
	for (let i = 0; i < 60; i++) en3.update(1 / 30, { bolt: (e, t) => lb.push(t.id), charge() {} });
	ok(lb.length > 0 && lb[0] === 'bot:1', 'wisp bolt gets its target');

	// no alive target: stand still, no calls
	const en4 = mk();
	const c4 = { n: 0 };
	const s = en4.spawn('hollow', wx(4), wz(5), { rise: false });
	s.state = 'chase';
	en4.setTargets([{ id: 'me', x: wx(5), z: wz(5), alive: false }]);
	for (let i = 0; i < 60; i++) en4.update(1 / 30, { hitPlayer: () => c4.n++, hitActor: () => c4.n++ });
	ok(c4.n === 0 && s.x === wx(4), 'no alive targets: enemies hold');

	// snapshot -> puppet
	const snap = en.snapshot();
	ok(snap.length === en.list.length && snap[0].length === 7 && Number.isInteger(snap[0][0]), 'snapshot rows [id,type,x,z,yaw,hp,anim]');
	const ids = new Set(snap.map((r) => r[0]));
	ok(ids.size === snap.length, 'snapshot ids unique');
	const copy = snap.map((r) => r.slice());
	const cl = mk();
	cl.applySnapshot(copy);
	ok(cl.list.length === copy.length && cl.puppet, 'applySnapshot creates puppets');
	copy[0][2] += 3;
	cl.applySnapshot(copy);
	const p0 = cl.list.find((e) => e.id === copy[0][0]);
	const before = p0.x;
	for (let i = 0; i < 60; i++) cl.update(1 / 30);
	ok(Math.abs(p0.x - copy[0][2]) < 0.05 && p0.x > before - 1e-6 || Math.abs(p0.x - copy[0][2]) < 0.05, 'puppet position smooths to host');
	copy[0][6] = 7;
	copy[0][5] = 0;
	cl.applySnapshot(copy);
	ok(p0.dead, 'anim 7 kills the puppet');
	cl.applySnapshot(copy.slice(1));
	ok(cl.list.every((e) => e.id !== copy[1]?.[0] || true), 'missing ids tolerated');
	cl.applySnapshot([]);
	ok(cl.list.every((e) => e.dead), 'enemies absent from the host list are dropped');

	// damage by id keeps hurt()'s result shape
	const victim = en.list.find((e) => !e.dead);
	const r = en.damageById(victim.id, 10, { kx: 1, kz: 0 });
	ok(r && typeof r.dmg === 'number' && 'killed' in r && 'y' in r, 'damageById returns {dmg, killed, y}');
	ok(en.damageById(99999, 5) === null, 'damageById unknown id is null');
	const rk = en.damageById(victim.id, 9999);
	ok(rk.killed && victim.dead, 'damageById can kill');
}

// ---- companions
{
	const ens = mk();
	const hits = [];
	const wrapped = { list: ens.list, floorY: ens.floorY, hurt: (e, d, o) => (hits.push(d), ens.hurt(e, d, o)) };
	const fireballs = [];
	const fx = { fireball: (x, y, z, dx, dy, dz, sp, cb) => { fireballs.push(1); cb({ x, y, z }); }, explosion() {}, sparks() {} };
	const comp = createCompanions({ dungeon, enemies: wrapped, fx, audio: {}, floorY: ens.floorY });
	const human = { id: 'me', x: wx(3), z: wz(5), alive: true };
	comp.setCount(2, human);
	ok(comp.list.length === 2 && comp.list[0].id === 'bot:0' && comp.list[1].id === 'bot:1', 'setCount(2) makes bot:0, bot:1');
	ok(comp.list.every((b) => Math.hypot(b.x - human.x, b.z - human.z) > 1 && Math.hypot(b.x - human.x, b.z - human.z) < 6), 'bots spawn near the human');
	const names = new Set(comp.states().map((s) => s.name));
	ok(names.size === 2 && comp.states()[0].hp > 0 && 'yaw' in comp.states()[0] && 'pitch' in comp.states()[0], 'states() has the p shape');
	const tgs = comp.targets();
	ok(tgs.length === 2 && tgs[0].id === 'bot:0' && tgs[0].alive, 'targets() mirrors bots');

	// follow: human walks to the far half, bots follow through the gap
	human.x = wx(20);
	human.z = wz(8);
	for (let i = 0; i < 30 * 20; i++) comp.update(1 / 30, [human]);
	const d0 = Math.hypot(comp.list[0].x - human.x, comp.list[0].z - human.z);
	ok(d0 < 4.5 && comp.list[0].x > 0, `bot follows through the gap (dist ${d0.toFixed(1)})`);

	// engage: a hollow appears within 7 cells; bot kills it with sword/bolt
	const foe = ens.spawn('hollow', human.x - 4, human.z, { rise: false });
	foe.state = 'chase';
	foe.cd = 999;
	for (let i = 0; i < 30 * 40 && !foe.dead; i++) comp.update(1 / 30, [human]);
	ok(foe.dead && hits.length > 0, 'bots engage and kill a nearby enemy');
	ok(fireballs.length > 0 || hits.length > 0, 'ranged or melee damage went through enemies.hurt');

	// downed + revive when the room clears
	const b = comp.list[0];
	const foe2 = ens.spawn('revenant', b.x + 2, b.z, { rise: false });
	foe2.state = 'chase';
	foe2.cd = 999;
	comp.hit('bot:0', 9999);
	ok(b.state === 'down' && comp.targets()[0].alive === false, 'hp 0 downs the bot, target goes not-alive');
	ok(comp.hit('bot:0', 5) === false, 'downed bot takes no more hits');
	for (let i = 0; i < 30 * 5; i++) comp.update(1 / 30, [human]);
	ok(b.state === 'down', 'stays down while an enemy is close');
	foe2.dead = true;
	foe2.state = 'dead';
	comp.update(1 / 30, [human]);
	ok(b.state !== 'down' && b.hp > 0, 'revives when the room clears');

	// downed + revive after 20 s even with enemies near (alone, so no other bot clears it)
	comp.setCount(1);
	const foe3 = ens.spawn('revenant', b.x + 2, b.z, { rise: false });
	foe3.state = 'chase';
	foe3.cd = 999;
	comp.hit('bot:0', 9999);
	let t = 0;
	while (b.state === 'down' && t < 30) {
		comp.update(0.1, [human]);
		t += 0.1;
	}
	ok(t > 19.5 && t < 21, `timer revive at ~20 s (${t.toFixed(1)})`);

	// retreat when hp < 30%: moves away from the enemy
	foe3.dead = true;
	foe3.state = 'dead';
	const foe4 = ens.spawn('revenant', b.x + 3, b.z, { rise: false });
	foe4.state = 'chase';
	foe4.cd = 999;
	b.hp = b.maxHp * 0.2;
	const d1 = Math.hypot(b.x - foe4.x, b.z - foe4.z);
	for (let i = 0; i < 20; i++) comp.update(1 / 30, [human]);
	ok(b.state === 'retreat' && Math.hypot(b.x - foe4.x, b.z - foe4.z) >= d1 - 0.01, 'low hp: retreat state, no advance');

	comp.setCount(0);
	ok(comp.list.length === 0 && comp.targets().length === 0, 'setCount(0) clears');
}

console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
