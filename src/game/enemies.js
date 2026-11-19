// The dead of the vault, from Patch's toolbox: plate knights risen as hollows and revenants (anymove knight, CC0),
// the ogre warden (anymove ogre, CC0), and wisps, which are drawn here from light alone.
// Positions are in cells, centred like the walker; drawn in metres.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CELL_M } from '../dungeon/view.js';
import { floorAt } from '../dungeon/floors.js';
import { bfsField, cellOf, pickTarget, stepDown } from '../party/bots.js';

const FLOOR = 1;

export const TYPES = {
	hollow: { file: 'knight', hp: 42, speed: 2.9, dmg: 10, reach: 1.3, height: 1.85, xp: 10, armor: 0.1, radius: 0.36, tint: [0.48, 0.44, 0.39], rough: 0.6, walkRate: 1.1, amb: 0.16 },
	revenant: { file: 'knight', hp: 100, speed: 2.25, dmg: 17, reach: 1.45, height: 2.2, xp: 24, armor: 0.3, radius: 0.42, tint: [0.27, 0.24, 0.23], rough: 0.4, walkRate: 0.85 },
	wisp: { file: null, hp: 26, speed: 2.7, dmg: 11, reach: 0, height: 1.6, xp: 16, armor: 0, ranged: true, radius: 0.3 },
	ogre: { file: 'ogre', hp: 720, speed: 2.0, dmg: 24, reach: 1.9, height: 3.3, xp: 150, armor: 0.1, boss: true, radius: 0.7, tint: [0.75, 0.75, 0.75], rough: 0.7 },
};

const ANIM = { idle: 'Idle', walk: 'Run', attack: 'Attack', attack2: 'Kick', hit: 'Hit', slam: 'GroundSlam', taunt: 'GroundSlam' };
// Wire anim indices (snapshot): idle walk attack kick hit slam taunt dead cast rise.
const WIRE = ['idle', 'walk', 'attack', 'attack2', 'hit', 'slam', 'taunt', 'dead', 'cast', 'rise'];
const TYPE_KEYS = Object.keys(TYPES);
const ONCE = ['attack', 'attack2', 'hit', 'slam', 'taunt'];

export async function loadEnemyAssets(onProgress) {
	const loader = new GLTFLoader();
	const files = ['knight', 'ogre'];
	const out = {};
	let done = 0;
	await Promise.all(files.map(async (f) => {
		out[f] = await loader.loadAsync(`./assets/models/${f}.glb`);
		onProgress?.(++done / files.length);
	}));
	for (const t of Object.values(TYPES)) {
		if (!t.file) continue;
		const g = out[t.file];
		const box = new THREE.Box3().setFromObject(g.scene, true);
		t.scale = t.height / Math.max(0.01, box.max.y - box.min.y);
		t.clips = Object.fromEntries(g.animations.map((a) => [a.name, a]));
		if (t.clips.Kick === undefined) t.clips.Kick = t.clips.Attack;
	}
	for (const g of Object.values(out)) g.scene.traverse((o) => o.isMesh && (o.frustumCulled = false));
	return out;
}

// A wisp: a hot core in a shell of light. Its trail comes from fx each frame.
const wispCore = new THREE.IcosahedronGeometry(0.13, 2);
const wispHalo = new THREE.PlaneGeometry(1.1, 1.1);
const HALO_VS = 'varying vec2 vU; void main(){ vU=uv*2.0-1.0; vec4 mv=modelViewMatrix*vec4(0.0,0.0,0.0,1.0); mv.xy+=position.xy; gl_Position=projectionMatrix*mv; }';
const HALO_FS = 'uniform vec3 uC; uniform float uK; varying vec2 vU; void main(){ float r=length(vU); float a=pow(max(0.0,1.0-r),3.0)*uK; gl_FragColor=vec4(uC*a,a); }';
function makeWisp() {
	const g = new THREE.Group();
	const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 2.6, 3.2) });
	const core = new THREE.Mesh(wispCore, coreMat);
	const haloMat = new THREE.ShaderMaterial({ vertexShader: HALO_VS, fragmentShader: HALO_FS, uniforms: { uC: { value: new THREE.Color(0.35, 0.9, 1.3) }, uK: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
	const halo = new THREE.Mesh(wispHalo, haloMat);
	halo.frustumCulled = false;
	core.position.y = halo.position.y = 1.35;
	g.add(core, halo);
	return { g, core, halo, haloMat, coreMat };
}

export function createEnemies({ scene, assets, dungeon: d, fx, audio, env }) {
	const list = [];
	const { W, H, grid } = d;
	const passable = (cx, cy) => cx >= 0 && cy >= 0 && cx < W && cy < H && grid[cy * W + cx] === FLOOR && d.walkable[cy * W + cx] === 1;
	const passAt = (x, z) => passable(Math.floor(x + W / 2), Math.floor(z + H / 2));
	const floorY = (x, z) => floorAt(d, x + W / 2, z + H / 2) * CELL_M;

	// Distance field from every alive target (multi-source), refreshed a few times a second.
	const dist = new Int16Array(W * H);
	const queue = new Int32Array(W * H);
	const src = new Int32Array(32);
	const tg = [];
	const me = { id: 'me', x: 0, z: 0, alive: true };
	let tn = 0;
	let puppet = false;
	let nextId = 1;
	let stamp = 0;
	let fieldT = 0;
	const snapRows = [];
	function buildField() {
		let n = 0;
		for (let i = 0; i < tn && n < 32; i++) if (tg[i].alive) src[n++] = cellOf(W, H, tg[i].x, tg[i].z);
		bfsField(grid, W, H, src, n, dist, queue, 60);
	}
	function setTargets(list) {
		tn = Math.min(list.length, 32);
		for (let i = 0; i < tn; i++) {
			const t = (tg[i] ||= { id: '', x: 0, z: 0, alive: true });
			t.id = list[i].id;
			t.x = list[i].x;
			t.z = list[i].z;
			t.alive = list[i].alive !== false;
		}
		fieldT = 0;
	}
	const wp = { x: 0, z: 0 };
	function lineClear(x0, z0, x1, z1) {
		const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 3);
		for (let i = 1; i < steps; i++) {
			const t = i / steps;
			if (grid[Math.floor(z0 + (z1 - z0) * t + H / 2) * W + Math.floor(x0 + (x1 - x0) * t + W / 2)] !== FLOOR) return false;
		}
		return true;
	}

	function spawn(type, x, z, { rise = true, roomId = -1, level = 1 } = {}) {
		const T = TYPES[type];
		let root;
		let mixer = { update() {} };
		const actions = {};
		const mats = [];
		let wisp = null;
		if (T.file) {
			root = SkeletonUtils.clone(assets[T.file].scene);
			root.scale.setScalar(T.scale);
			root.traverse((o) => {
				if (!o.isMesh) return;
				const m = (o.material = o.material.clone());
				m.color.setRGB(...T.tint);
				m.roughness = T.rough;
				// Lit by the lamps, plus a little of their own colour as ambient: far cheaper than a reflection map.
				m.emissiveMap = m.map;
				m.emissive = new THREE.Color(0, 0, 0);
				m.metalness = Math.min(m.metalness ?? 1, 0.55);
				const amb = T.amb ?? 0.22;
				m.userData.amb = T.tint.map((c) => c * amb);
				m.emissive.setRGB(...m.userData.amb);
				mats.push(m);
			});
			mixer = new THREE.AnimationMixer(root);
			for (const [k, n] of Object.entries(ANIM)) if (T.clips[n]) actions[k] = mixer.clipAction(T.clips[n]);
			for (const k of ONCE) {
				if (!actions[k]) continue;
				actions[k].setLoop(THREE.LoopOnce, 1);
				actions[k].clampWhenFinished = true;
			}
		} else {
			wisp = makeWisp();
			root = wisp.g;
		}
		scene.add(root);
		const lv = level - 1;
		const e = {
			type,
			T,
			root,
			mixer,
			actions,
			mats,
			wisp,
			x,
			z,
			vx: 0,
			vz: 0,
			kx: 0,
			kz: 0,
			yaw: Math.random() * Math.PI * 2,
			hp: Math.round(T.hp * (1 + lv * 0.28)),
			maxHp: Math.round(T.hp * (1 + lv * 0.28)),
			dmg: Math.round(T.dmg * (1 + lv * 0.15)),
			speed: T.speed * (0.9 + Math.random() * 0.2) * (1 + lv * 0.04),
			radius: T.radius,
			state: 'chase',
			t: 0,
			cd: 0.6 + Math.random(),
			slamCd: 5,
			flash: 0,
			roomId,
			current: null,
			fall: 0,
			sink: 0,
			phase: Math.random() * 10,
			dead: false,
			gone: false,
			struck: false,
			id: nextId++,
			ti: TYPE_KEYS.indexOf(type),
			tgt: null,
			kick: false,
			pa: -1,
			wa: 0,
			pv: 0,
			seen: 0,
			px: x,
			pz: z,
			pyaw: 0,
		};
		play(e, 'idle', 0);
		if (T.boss) {
			e.state = 'taunt';
			play(e, 'taunt', 0.1);
			e.t = 1.4;
		} else if (rise) {
			// Up out of the floor, through a burst of grave dust.
			e.state = 'rise';
			e.t = wisp ? 0.6 : 1.1;
			e.sink = 1;
			fx.riseDust(x * CELL_M, floorY(x, z), z * CELL_M);
		}
		place(e);
		list.push(e);
		return e;
	}

	function visuals(e, dt, near) {
		if (e.flash > 0) {
			e.flash -= dt;
			const f = Math.max(0, e.flash) * 1.6;
			for (const m of e.mats) m.emissive.setRGB(m.userData.amb[0] + f * (e.flashFire ? 1.4 : 1), m.userData.amb[1] + f * (e.flashFire ? 0.5 : 0.9), m.userData.amb[2] + f * (e.flashFire ? 0.15 : 0.8));
			if (e.wisp) e.wisp.haloMat.uniforms.uK.value = 1 + f;
		}
		if (near) e.mixer.update(dt);
		if (e.wisp && !e.dead) {
			const p = e.root.position;
			fx.wispTrail(p.x, p.y + 1.35, p.z, e.state === 'cast' ? 2 : 1);
			e.wisp.core.scale.setScalar(1 + Math.sin(e.phase * 13) * 0.08 + (e.state === 'cast' ? (0.7 - Math.max(0, e.t)) * 1.4 : 0));
		}
	}

	// Falling and sinking after death; true once the body is gone from the list.
	function tickDead(e, i, dt) {
		if (e.wisp) {
			scene.remove(e.root);
			e.gone = true;
			list.splice(i, 1);
			return true;
		}
		e.fall = Math.min(1.45, e.fall + dt * (1.2 + e.fall * 3));
		e.root.rotation.x = -e.fall;
		if (e.t < 1) e.root.position.y -= dt * (e.T.boss ? 1.2 : 0.6);
		if (e.t <= 0) {
			scene.remove(e.root);
			e.gone = true;
			list.splice(i, 1);
			return true;
		}
		return false;
	}

	function play(e, name, fade = 0.15) {
		const a = e.actions[name];
		if (!a) return 0;
		if (e.current === a && a.loop === THREE.LoopRepeat && a.isRunning()) return a.getClip().duration;
		a.reset();
		a.timeScale = 1;
		a.enabled = true;
		a.setEffectiveWeight(1);
		a.play();
		if (e.current && e.current !== a) e.current.crossFadeTo(a, fade, false);
		e.current = a;
		return a.getClip().duration;
	}

	function place(e) {
		const y = floorY(e.x, e.z);
		if (e.wisp) {
			e.root.position.set(e.x * CELL_M, y + Math.sin(e.phase * 2.1) * 0.12 - e.sink * 1.2, e.z * CELL_M);
			return;
		}
		e.root.position.set(e.x * CELL_M, y - e.sink * e.T.height * 1.05, e.z * CELL_M);
		e.root.rotation.y = e.yaw;
	}

	function move(e, dx, dz) {
		const r = e.radius * 0.7;
		const nx = e.x + dx;
		if (passAt(nx + Math.sign(dx) * r, e.z) && passAt(nx + Math.sign(dx) * r, e.z + r) && passAt(nx + Math.sign(dx) * r, e.z - r)) e.x = nx;
		const nz = e.z + dz;
		if (passAt(e.x, nz + Math.sign(dz) * r) && passAt(e.x + r, nz + Math.sign(dz) * r) && passAt(e.x - r, nz + Math.sign(dz) * r)) e.z = nz;
	}

	function turnTo(e, tx, tz, dt, rate = 10) {
		const want = Math.atan2(tx - e.x, tz - e.z);
		let dy = want - e.yaw;
		dy = Math.atan2(Math.sin(dy), Math.cos(dy));
		e.yaw += dy * Math.min(1, dt * rate);
	}

	function hurt(e, amount, { kx = 0, kz = 0, stagger = true, fire = false } = {}) {
		if (e.dead) return null;
		const dmg = Math.max(1, Math.round(amount * (1 - e.T.armor)));
		e.hp -= dmg;
		e.flash = fire ? 0.35 : 0.18;
		e.flashFire = fire;
		const kb = e.T.boss ? 0.15 : e.type === 'revenant' ? 0.6 : 1;
		e.kx += kx * kb;
		e.kz += kz * kb;
		const y = floorY(e.x, e.z);
		if (e.hp <= 0) {
			kill(e);
			return { dmg, killed: true, y };
		}
		const canStagger = e.state !== 'rise' && (!e.T.boss || (e.state === 'chase' && Math.random() < 0.12));
		if (stagger && canStagger && !(e.type === 'revenant' && e.state === 'attack' && Math.random() < 0.6)) {
			e.state = 'hit';
			e.t = e.T.boss ? 0.45 : 0.34;
			play(e, 'hit', 0.05);
			if (e.current) e.current.timeScale = 1.6;
		}
		return { dmg, killed: false, y };
	}

	function kill(e) {
		e.dead = true;
		e.state = 'dead';
		e.t = e.T.boss ? 3.2 : e.wisp ? 0.01 : 2.4;
		const y = floorY(e.x, e.z);
		const cx = e.x * CELL_M;
		const cz = e.z * CELL_M;
		if (e.wisp) {
			fx.explosion(cx, e.root.position.y + 1.35, cz, 0.45);
			fx.soul(cx, y + 0.8, cz, [0.5, 1.8, 2.4]);
			audio.boneBreak();
			return;
		}
		play(e, 'hit', 0.05);
		if (e.current) e.current.timeScale = 0.35;
		if (e.T.boss) {
			fx.explosion(cx, y + 1.4, cz, 1.6);
			fx.blood(cx, y + 2, cz, 60, y);
		} else {
			fx.sparks(cx, y + 1.2, cz, 26, [3, 1.5, 0.6], 5);
			fx.bones(cx, y + 1.0, cz, 10, y);
			audio.hitArmor();
		}
		fx.soul(cx, y, cz, e.T.boss ? [2, 1, 0.4] : [0.5, 1.6, 1.4]);
	}

	// Wire anim index of what an enemy is doing.
	function animOf(e) {
		switch (e.state) {
			case 'rise': return 9;
			case 'taunt': return 6;
			case 'hit': return 4;
			case 'attack': return e.kick ? 3 : 2;
			case 'slam': return 5;
			case 'cast': return 8;
			case 'dead': return 7;
			default: return Math.hypot(e.vx, e.vz) > 0.3 ? 1 : 0;
		}
	}

	function byId(id) {
		for (const e of list) if (e.id === id) return e;
		return null;
	}

	// Puppet side: take the host's anim for this enemy, starting the clip only when it changes.
	function setAnim(e, a) {
		if (e.pa !== a) {
			const was = e.pa;
			e.pa = a;
			if (was === 9) e.sink = 0;
			switch (a) {
				case 9:
					e.state = 'rise';
					e.t = e.wisp ? 0.6 : 1.1;
					e.sink = 1;
					fx.riseDust(e.x * CELL_M, floorY(e.x, e.z), e.z * CELL_M);
					break;
				case 2:
				case 3: {
					e.state = 'attack';
					const dur = play(e, a === 3 ? 'attack2' : 'attack', 0.08);
					const ts = e.T.boss ? 1.0 : e.type === 'hollow' ? 1.35 : 1.15;
					if (e.current) e.current.timeScale = ts;
					e.t = dur / ts;
					break;
				}
				case 4:
					e.state = 'hit';
					play(e, 'hit', 0.05);
					if (e.current) e.current.timeScale = 1.6;
					break;
				case 5:
				case 6:
					e.state = a === 5 ? 'slam' : 'taunt';
					play(e, 'slam', 0.1);
					break;
				case 8:
					e.state = 'cast';
					e.t = 0.7;
					break;
				default:
					e.state = 'chase';
					play(e, a === 1 ? 'walk' : 'idle', 0.2);
			}
		}
		if (a === 1 && e.actions.walk) e.actions.walk.timeScale = e.T.boss ? 0.95 : Math.max(0.5, (e.pv / 3) * (e.T.walkRate ?? 1));
	}

	function puppetUpdate(dt) {
		const k = Math.min(1, dt * 12);
		for (let i = list.length - 1; i >= 0; i--) {
			const e = list[i];
			e.t -= dt;
			e.phase += dt;
			if (e.dead) {
				visuals(e, dt, true);
				if (tickDead(e, i, dt)) continue;
				place(e);
				continue;
			}
			const ox = e.x;
			const oz = e.z;
			e.x += (e.px - e.x) * k;
			e.z += (e.pz - e.z) * k;
			let dy = e.pyaw - e.yaw;
			dy = Math.atan2(Math.sin(dy), Math.cos(dy));
			e.yaw += dy * k;
			e.pv = dt > 0 ? Math.hypot(e.x - ox, e.z - oz) / dt : 0;
			if (e.state === 'rise') e.sink = Math.max(0, e.t / (e.wisp ? 0.6 : 1.1)) ** 2;
			setAnim(e, e.wa);
			let near = true;
			if (tn > 0) near = Math.hypot(tg[0].x - e.x, tg[0].z - e.z) < 34;
			visuals(e, dt, near);
			place(e);
		}
	}

	// Host side: compact rows [id, typeIndex, x, z, yaw, hp, anim], reused between calls (encode before the next call).
	function snapshot() {
		let n = 0;
		for (const e of list) {
			const r = (snapRows[n] ||= [0, 0, 0, 0, 0, 0, 0]);
			r[0] = e.id;
			r[1] = e.ti;
			r[2] = Math.round(e.x * 100) / 100;
			r[3] = Math.round(e.z * 100) / 100;
			r[4] = Math.round(e.yaw * 100) / 100;
			r[5] = Math.max(0, e.hp);
			r[6] = animOf(e);
			n++;
		}
		snapRows.length = n;
		return snapRows;
	}

	// Client side: become a puppet of the host's list. No AI, no damage.
	function applySnapshot(rows) {
		puppet = true;
		stamp++;
		for (let i = 0; i < rows.length; i++) {
			const [id, ti, x, z, yaw, hp, anim] = rows[i];
			let e = byId(id);
			if (!e) {
				if (anim === 7 || !TYPE_KEYS[ti]) continue;
				e = spawn(TYPE_KEYS[ti], x, z, { rise: false });
				e.id = id;
				nextId = Math.max(nextId, id + 1);
				e.state = 'chase';
				e.t = 0;
				e.px = x;
				e.pz = z;
				e.yaw = e.pyaw = yaw;
				e.pa = -1;
				e.wa = anim;
				e.hp = hp;
			}
			e.seen = stamp;
			e.px = x;
			e.pz = z;
			e.pyaw = yaw;
			if (hp < e.hp && !e.dead) {
				e.flash = 0.18;
				e.flashFire = false;
			}
			e.hp = hp;
			if (e.dead) continue;
			if (anim === 7) kill(e);
			else e.wa = anim;
		}
		// Gone from the host's list and not dying here: drop it.
		for (let i = list.length - 1; i >= 0; i--) {
			const e = list[i];
			if (e.dead || e.seen === stamp) continue;
			scene.remove(e.root);
			e.gone = true;
			list.splice(i, 1);
		}
	}

	// Host applying a client's hit: same path and result shape as hurt().
	function damageById(id, dmg, opts) {
		const e = byId(id);
		return e ? hurt(e, dmg, opts) : null;
	}

	return {
		snapshot,
		applySnapshot,
		damageById,
		get puppet() {
			return puppet;
		},
		set puppet(v) {
			puppet = !!v;
		},
		list,
		spawn,
		hurt,
		lineClear,
		passAt,
		floorY,
		get alive() {
			let n = 0;
			for (const e of list) if (!e.dead) n++;
			return n;
		},
		setTargets,
		update(dt, a, b) {
			// update(dt, hooks) after setTargets, or the old update(dt, player, hooks): one target, 'me'.
			let hooks = a;
			if (b !== undefined) {
				hooks = b;
				me.x = a.x;
				me.z = a.z;
				tg[0] = me;
				tn = 1;
			}
			if (puppet) return puppetUpdate(dt);
			fieldT -= dt;
			if (fieldT <= 0) {
				fieldT = 0.2;
				buildField();
			}
			for (let i = list.length - 1; i >= 0; i--) {
				const e = list[i];
				const tgt = (e.tgt = pickTarget(tg, tn, e.x, e.z, e.tgt));
				const TX = tgt ? tgt.x : e.x;
				const TZ = tgt ? tgt.z : e.z;
				const px = TX - e.x;
				const pz = TZ - e.z;
				const pd = Math.hypot(px, pz);
				e.t -= dt;
				e.cd -= dt;
				e.slamCd -= dt;
				e.phase += dt;
				if (e.kx || e.kz) {
					move(e, e.kx * dt, e.kz * dt);
					const k = Math.exp(-dt * 9);
					e.kx *= k;
					e.kz *= k;
					if (Math.abs(e.kx) + Math.abs(e.kz) < 0.01) e.kx = e.kz = 0;
				}
				visuals(e, dt, pd < 34);
				switch (e.state) {
					case 'rise':
						e.sink = Math.max(0, e.t / (e.wisp ? 0.6 : 1.1)) ** 2;
						if (!e.wisp && Math.random() < 0.08) fx.riseDust(e.x * CELL_M, floorY(e.x, e.z), e.z * CELL_M);
						turnTo(e, TX, TZ, dt, 6);
						if (e.t <= 0) {
							e.sink = 0;
							e.state = 'chase';
							play(e, 'walk', 0.2);
						}
						break;
					case 'taunt':
						turnTo(e, TX, TZ, dt, 4);
						if (e.t <= 0) {
							e.state = 'chase';
							play(e, 'walk', 0.3);
						}
						break;
					case 'hit':
						if (e.t <= 0) {
							e.state = 'chase';
							play(e, 'walk', 0.15);
						}
						break;
					case 'chase': {
						if (!tgt || pd > 40) break;
						const T = e.T;
						const sees = pd < 11 && lineClear(e.x, e.z, TX, TZ);
						if (T.ranged && sees && pd < 8.5 && e.cd <= 0) {
							e.state = 'cast';
							e.t = 0.7;
							e.fireAt = 0.15;
							e.struck = false;
							e.tid = tgt.id;
							hooks.charge?.(e);
							break;
						}
						if (T.boss && pd < 3.5 && e.slamCd <= 0 && sees) {
							e.state = 'slam';
							const dur = play(e, 'slam', 0.1);
							e.current.timeScale = 1.1;
							e.t = dur / 1.1;
							e.hitAt = e.t * 0.5;
							e.struck = false;
							e.slamCd = 6 + Math.random() * 2;
							hooks.telegraph?.(e, 3.4);
							break;
						}
						if (!T.ranged && pd < T.reach && e.cd <= 0) {
							e.state = 'attack';
							const kick = !T.boss && pd < T.reach * 0.7 && Math.random() < 0.3;
							e.kick = kick;
							const dur = play(e, kick ? 'attack2' : 'attack', 0.08);
							const ts = T.boss ? 1.0 : e.type === 'hollow' ? 1.35 : 1.15;
							e.current.timeScale = ts;
							e.t = dur / ts;
							e.hitAt = e.t * 0.48;
							e.struck = false;
							hooks.windup?.(e);
							break;
						}
						let tx;
						let tz;
						if (sees && (!T.ranged || pd > 5)) {
							tx = TX;
							tz = TZ;
						} else if (T.ranged && sees && pd < 4) {
							tx = e.x - px;
							tz = e.z - pz;
						} else {
							tx = TX;
							tz = TZ;
							if (stepDown(grid, W, H, dist, e.x, e.z, wp)) {
								tx = wp.x;
								tz = wp.z;
							}
						}
						let mx = tx - e.x;
						let mz = tz - e.z;
						const ml = Math.hypot(mx, mz) || 1;
						mx /= ml;
						mz /= ml;
						// Strafe a little when close, so a crowd circles instead of queueing.
						if (sees && pd < 3 && !T.boss) {
							const side = Math.sin(e.phase * 0.7 + i) * 0.5;
							mx += -mz * side;
							mz += mx * side;
						}
						for (const o of list) {
							if (o === e || o.dead) continue;
							const ox = e.x - o.x;
							const oz = e.z - o.z;
							const q = ox * ox + oz * oz;
							const rr = e.radius + o.radius + 0.1;
							if (q < rr * rr && q > 1e-6) {
								const l = Math.sqrt(q);
								mx += (ox / l) * (rr - l) * 3;
								mz += (oz / l) * (rr - l) * 3;
							}
						}
						const stop = !T.ranged && pd < T.reach * 0.8;
						const sp = stop ? 0 : e.speed;
						e.vx += (mx * sp - e.vx) * Math.min(1, dt * 8);
						e.vz += (mz * sp - e.vz) * Math.min(1, dt * 8);
						move(e, e.vx * dt, e.vz * dt);
						turnTo(e, sees ? TX : e.x + e.vx, sees ? TZ : e.z + e.vz, dt);
						if (e.actions.walk) {
							if (e.current !== e.actions.walk) play(e, 'walk', 0.2);
							e.actions.walk.timeScale = T.boss ? 0.95 : Math.max(0.5, (Math.hypot(e.vx, e.vz) / 3) * (T.walkRate ?? 1));
						}
						break;
					}
					case 'attack':
						turnTo(e, TX, TZ, dt, e.t > e.hitAt ? 8 : 1);
						if (!e.struck && e.t <= e.hitAt) {
							e.struck = true;
							const fwd = Math.cos(Math.atan2(px, pz) - e.yaw);
							if (tgt && pd < e.T.reach + 0.45 && fwd > 0.3) {
								if (tgt.id === 'me') hooks.hitPlayer(e, e.dmg);
								else hooks.hitActor?.(e, tgt.id, e.dmg, 'melee');
							} else hooks.whiff?.(e);
						}
						if (e.t <= 0) {
							e.state = 'chase';
							e.cd = e.T.boss ? 0.7 : 0.8 + Math.random() * 0.7;
							play(e, 'walk', 0.15);
						}
						break;
					case 'slam':
						if (!e.struck && e.t <= e.hitAt) {
							e.struck = true;
							hooks.slam(e, 3.4);
							// The hook hits 'me'; anyone else in the ring is ours to hit.
							const sx = e.x + Math.sin(e.yaw) * 1.2;
							const sz = e.z + Math.cos(e.yaw) * 1.2;
							for (let k = 0; k < tn; k++) if (tg[k].alive && tg[k].id !== 'me' && Math.hypot(tg[k].x - sx, tg[k].z - sz) < 3.4) hooks.hitActor?.(e, tg[k].id, Math.round(e.dmg * 1.3), 'slam');
						}
						if (e.t <= 0) {
							e.state = 'chase';
							e.cd = 0.5;
							play(e, 'walk', 0.2);
						}
						break;
					case 'cast':
						turnTo(e, TX, TZ, dt, 8);
						if (!e.struck && e.t <= e.fireAt) {
							e.struck = true;
							hooks.bolt(e, e.tgt);
						}
						if (e.t <= 0) {
							e.state = 'chase';
							e.cd = 2 + Math.random() * 1.2;
						}
						break;
					case 'dead':
						tickDead(e, i, dt);
						continue;
				}
				place(e);
			}
		},
		clear() {
			for (const e of list) scene.remove(e.root);
			list.length = 0;
		},
		findSpot(x, z, r0, r1, tries = 40) {
			for (let i = 0; i < tries; i++) {
				const a = Math.random() * Math.PI * 2;
				const r = r0 + Math.random() * (r1 - r0);
				const sx = x + Math.cos(a) * r;
				const sz = z + Math.sin(a) * r;
				const cx = Math.floor(sx + W / 2);
				const cy = Math.floor(sz + H / 2);
				if (!passable(cx, cy) || !passable(cx + 1, cy) || !passable(cx - 1, cy) || !passable(cx, cy + 1) || !passable(cx, cy - 1)) continue;
				if (dist[cy * W + cx] < 0) continue;
				return { x: cx + 0.5 - W / 2, z: cy + 0.5 - H / 2 };
			}
			return null;
		},
	};
}
