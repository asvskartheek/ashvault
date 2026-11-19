// The dead of the vault, from Patch's toolbox: plate knights risen as hollows and revenants (anymove knight, CC0),
// the ogre warden (anymove ogre, CC0), and wisps, which are drawn here from light alone.
// Positions are in cells, centred like the walker; drawn in metres.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CELL_M } from '../dungeon/view.js';
import { floorAt } from '../dungeon/floors.js';

const FLOOR = 1;

export const TYPES = {
	hollow: { file: 'knight', hp: 42, speed: 2.9, dmg: 10, reach: 1.3, height: 1.85, xp: 10, armor: 0.1, radius: 0.36, tint: [0.48, 0.44, 0.39], rough: 0.6, walkRate: 1.1, amb: 0.16 },
	revenant: { file: 'knight', hp: 100, speed: 2.25, dmg: 17, reach: 1.45, height: 2.2, xp: 24, armor: 0.3, radius: 0.42, tint: [0.27, 0.24, 0.23], rough: 0.4, walkRate: 0.85 },
	wisp: { file: null, hp: 26, speed: 2.7, dmg: 11, reach: 0, height: 1.6, xp: 16, armor: 0, ranged: true, radius: 0.3 },
	ogre: { file: 'ogre', hp: 720, speed: 2.0, dmg: 24, reach: 1.9, height: 3.3, xp: 150, armor: 0.1, boss: true, radius: 0.7, tint: [0.75, 0.75, 0.75], rough: 0.7 },
};

const ANIM = { idle: 'Idle', walk: 'Run', attack: 'Attack', attack2: 'Kick', hit: 'Hit', slam: 'GroundSlam', taunt: 'GroundSlam' };
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

	// Distance field from the player over the floor, refreshed a few times a second.
	const dist = new Int16Array(W * H);
	const queue = new Int32Array(W * H);
	let fieldT = 0;
	function buildField(px, pz) {
		dist.fill(-1);
		const sx = Math.floor(px + W / 2);
		const sy = Math.floor(pz + H / 2);
		if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
		let qh = 0;
		let qt = 0;
		dist[sy * W + sx] = 0;
		queue[qt++] = sy * W + sx;
		while (qh < qt) {
			const c = queue[qh++];
			const cx = c % W;
			const cy = (c / W) | 0;
			const dv = dist[c];
			if (dv > 60) continue;
			for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
				const nx = cx + ox;
				const ny = cy + oy;
				if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
				const n = ny * W + nx;
				if (dist[n] !== -1 || grid[n] !== FLOOR) continue;
				dist[n] = dv + 1;
				queue[qt++] = n;
			}
		}
	}
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

	return {
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
		update(dt, player, hooks) {
			fieldT -= dt;
			if (fieldT <= 0) {
				fieldT = 0.2;
				buildField(player.x, player.z);
			}
			for (let i = list.length - 1; i >= 0; i--) {
				const e = list[i];
				const px = player.x - e.x;
				const pz = player.z - e.z;
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
				if (e.flash > 0) {
					e.flash -= dt;
					const f = Math.max(0, e.flash) * 1.6;
					for (const m of e.mats) m.emissive.setRGB(m.userData.amb[0] + f * (e.flashFire ? 1.4 : 1), m.userData.amb[1] + f * (e.flashFire ? 0.5 : 0.9), m.userData.amb[2] + f * (e.flashFire ? 0.15 : 0.8));
					if (e.wisp) e.wisp.haloMat.uniforms.uK.value = 1 + f;
				}
				if (pd < 34) e.mixer.update(dt);
				if (e.wisp && !e.dead) {
					const p = e.root.position;
					fx.wispTrail(p.x, p.y + 1.35, p.z, e.state === 'cast' ? 2 : 1);
					e.wisp.core.scale.setScalar(1 + Math.sin(e.phase * 13) * 0.08 + (e.state === 'cast' ? (0.7 - Math.max(0, e.t)) * 1.4 : 0));
				}
				switch (e.state) {
					case 'rise':
						e.sink = Math.max(0, e.t / (e.wisp ? 0.6 : 1.1)) ** 2;
						if (!e.wisp && Math.random() < 0.08) fx.riseDust(e.x * CELL_M, floorY(e.x, e.z), e.z * CELL_M);
						turnTo(e, player.x, player.z, dt, 6);
						if (e.t <= 0) {
							e.sink = 0;
							e.state = 'chase';
							play(e, 'walk', 0.2);
						}
						break;
					case 'taunt':
						turnTo(e, player.x, player.z, dt, 4);
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
						if (pd > 40) break;
						const T = e.T;
						const sees = pd < 11 && lineClear(e.x, e.z, player.x, player.z);
						if (T.ranged && sees && pd < 8.5 && e.cd <= 0) {
							e.state = 'cast';
							e.t = 0.7;
							e.fireAt = 0.15;
							e.struck = false;
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
							tx = player.x;
							tz = player.z;
						} else if (T.ranged && sees && pd < 4) {
							tx = e.x - px;
							tz = e.z - pz;
						} else {
							const cx = Math.floor(e.x + W / 2);
							const cy = Math.floor(e.z + H / 2);
							let best = dist[cy * W + cx];
							tx = player.x;
							tz = player.z;
							if (best < 0) best = 9999;
							for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
								const n = (cy + oy) * W + cx + ox;
								const dv = dist[n];
								if (dv < 0 || dv >= best) continue;
								if (ox && oy && (grid[cy * W + cx + ox] !== FLOOR || grid[(cy + oy) * W + cx] !== FLOOR)) continue;
								best = dv;
								tx = cx + ox + 0.5 - W / 2;
								tz = cy + oy + 0.5 - H / 2;
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
						turnTo(e, sees ? player.x : e.x + e.vx, sees ? player.z : e.z + e.vz, dt);
						if (e.actions.walk) {
							if (e.current !== e.actions.walk) play(e, 'walk', 0.2);
							e.actions.walk.timeScale = T.boss ? 0.95 : Math.max(0.5, (Math.hypot(e.vx, e.vz) / 3) * (T.walkRate ?? 1));
						}
						break;
					}
					case 'attack':
						turnTo(e, player.x, player.z, dt, e.t > e.hitAt ? 8 : 1);
						if (!e.struck && e.t <= e.hitAt) {
							e.struck = true;
							const fwd = Math.cos(Math.atan2(px, pz) - e.yaw);
							if (pd < e.T.reach + 0.45 && fwd > 0.3) hooks.hitPlayer(e, e.dmg);
							else hooks.whiff?.(e);
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
						}
						if (e.t <= 0) {
							e.state = 'chase';
							e.cd = 0.5;
							play(e, 'walk', 0.2);
						}
						break;
					case 'cast':
						turnTo(e, player.x, player.z, dt, 8);
						if (!e.struck && e.t <= e.fireAt) {
							e.struck = true;
							hooks.bolt(e);
						}
						if (e.t <= 0) {
							e.state = 'chase';
							e.cd = 2 + Math.random() * 1.2;
						}
						break;
					case 'dead':
						if (e.wisp) {
							scene.remove(e.root);
							e.gone = true;
							list.splice(i, 1);
							continue;
						}
						e.fall = Math.min(1.45, e.fall + dt * (1.2 + e.fall * 3));
						e.root.rotation.x = -e.fall;
						if (e.t < 1) e.root.position.y -= dt * (e.T.boss ? 1.2 : 0.6);
						if (e.t <= 0) {
							scene.remove(e.root);
							e.gone = true;
							list.splice(i, 1);
						}
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
