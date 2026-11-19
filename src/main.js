// ASHVAULT: a first-person fight down through a crypt that is forged fresh in the browser each floor.
// The crypt is Patch's "Realistic Procedural Dungeons" block (src/dungeon); the dead, sounds and stone are from Patch's toolbox.
import { Color, MeshDepthMaterial, NearestFilter, PointLight, RGBADepthPacking, TextureLoader, WebGLRenderTarget, Vector3, Mesh, CylinderGeometry, ShaderMaterial, AdditiveBlending, DoubleSide } from 'three';
import { buildCrypt } from './dungeon/crypt.js';
import { floorAt } from './dungeon/floors.js';
import { createView, CELL_M } from './dungeon/view.js';
import { createWalker } from './dungeon/walker.js';
import { createAudio } from './game/audio.js';
import { createFx, createNumbers } from './game/fx.js';
import { createWeapon } from './game/weapon.js';
import { createEnemies, loadEnemyAssets } from './game/enemies.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TEST = params.get('patch-test') === '1';
const MUTED = params.has('mute') || TEST;
const BASE_SEED = Number(params.get('seed')) || ((Math.random() * 1e9) | 0);
let quality = window.patch?.quality ?? params.get('q') ?? 'high';

const WALK = 3.1;
const RUN = 4.6;
const EYE = 1.07;
const LOOK = 0.0021;

const audio = createAudio({ muted: MUTED });
let canvas = null;
let view;
let dungeon;
let walker;
let lamps;
let shadowLights;
let fx;
let numbers;
let weapon;
let enemies;
let assets;
let scans;
let rift = null;

let mode = 'loading'; // loading | title | play | pause | boons | dead | descend
let time = 0;
let last = 0;
let eyeFloor = 0;
let hitStop = 0;
let slowMo = 0;
let shake = 0;
let fovKick = 0;
let lastDevice = 'kb';

const keys = new Set();
const mouse = { l: false, r: false, lPressed: false, rPressed: false };
let lookX = 0;
let lookY = 0;

// The run.
const R = {};
function newRun() {
	Object.assign(R, { floor: 1, level: 1, xp: 0, hp: 100, maxHp: 100, mana: 100, maxMana: 100, potions: 2, kills: 0, t: 0, boons: {}, dashCd: 0, dashT: 0, dashX: 0, dashZ: 0, waveCd: 0, potCd: 0, iframes: 0, regenDelay: 0, ambushT: 14, cleared: new Set(), active: new Set(), pending: {}, bossAlive: false, boss: null });
}
const xpNext = () => Math.round(60 * R.level ** 1.35);
const B = (k) => R.boons[k] ?? 0;

// ---------------------------------------------------------------- building a floor
function say(v) {
	$('load').style.transform = `scaleX(${v})`;
	return new Promise((r) => setTimeout(r));
}

function buildLevel(seed, rooms) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./dungeon/build-worker.js', import.meta.url), { type: 'module' });
		worker.onerror = (e) => reject(new Error(e.message));
		worker.onmessage = ({ data }) => {
			if (data.type === 'masonry') {
				view.setMasonry(data);
				worker.postMessage({ type: 'level', id: 1, params: { seed, rooms, loops: 0.35, decor: 0.6, theme: 'verdant' } });
				return;
			}
			worker.terminate();
			resolve(data);
		};
		worker.postMessage({ type: 'masonry' });
	});
}

function freshCanvas() {
	if (view) {
		enemies?.clear();
		view.renderer.dispose();
		view.renderer.forceContextLoss();
	}
	canvas?.remove();
	canvas = document.createElement('canvas');
	canvas.tabIndex = 0;
	document.body.prepend(canvas);
	canvas.addEventListener('mousedown', onMouseDown);
	canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

const LOOKS = { high: { cap: 1.25, budget: 1300000, ao: true, fx: 1, shadows: 2 }, medium: { cap: 1, budget: 1000000, ao: true, fx: 0.7, shadows: 2 }, low: { cap: 0.75, budget: 600000, ao: false, fx: 0.45, shadows: 1 } };
let pixelCap = 1.25;

async function buildFloor(n) {
	mode = 'loading';
	$('cover').style.display = '';
	$('cover').classList.remove('done');
	$('hud').classList.add('off');
	freshCanvas();
	const Q = LOOKS[quality] ?? LOOKS.high;
	pixelCap = Q.cap;
	view = createView(canvas, { pixelCap, pixelBudget: Q.budget });
	view.setResScale(resScale);
	view.rig.t = 1;
	view.rig.fov = 74;
	await say(0.1);
	if (!scans) {
		const loader = new TextureLoader();
		const scan = async (base) => {
			const [color, normal, roughness, height] = await Promise.all(['baseColor', 'normal', 'roughness', 'displacement'].map((m) => loader.loadAsync(`${base}_${m}.jpg`)));
			return { color, normal, roughness, height };
		};
		const assetsP = assets ? Promise.resolve(assets) : loadEnemyAssets((v) => say(0.1 + v * 0.3));
		const [wall, floor, plaster, a] = await Promise.all([scan('./assets/materials/medievalBlocks05/medieval_blocks_05'), scan('./assets/materials/dirtFloor/dirt_floor'), scan('./assets/materials/medievalWall01/medieval_wall_01'), assetsP]);
		scans = { wall, floor, plaster };
		assets = a;
	}
	view.setScans(scans);
	await say(0.45);
	const built = await buildLevel((BASE_SEED + n * 7919) >>> 0, Math.min(22, 11 + n * 2));
	dungeon = built.dungeon;
	view.setLevel(dungeon, built.level, { reveal: false });
	await say(0.7);
	lamps = buildCrypt(view, dungeon, built.level);
	shadowLights = makeShadowLights(Q.shadows);
	fx = createFx(view.scene, { budget: Q.fx });
	numbers = numbers ?? createNumbers($('nums'));
	weapon = createWeapon(view.renderer);
	view.overlay = weapon.scene;
	view.overlayCamera = weapon.camera;
	if (Q.ao) setUpDepth();
	else view.POST.fin.uniforms.uAO.value = 0;
	walker = createWalker(dungeon);
	walker.start();
	enemies = createEnemies({ scene: view.scene, assets, dungeon, fx, audio, numbers, env: weapon.env });
	rift = null;
	R.cleared = new Set();
	R.active = new Set();
	R.pending = {};
	R.ambushT = 12;
	R.bossAlive = false;
	R.boss = null;
	syncEye();
	for (let i = 0; i < 40; i++) placeLights(0.1);
	await say(0.9);
	// Warm every shader: one of each enemy, a fireball and a burst, drawn once out of sight.
	const warm = ['hollow', 'revenant', 'wisp', 'ogre'].map((t) => enemies.spawn(t, walker.x + Math.sin(walker.yaw) * -3, walker.z + Math.cos(walker.yaw) * -3, { rise: false }));
	fx.explosion(0, -50, 0, 0.1);
	view.frame(0, 0);
	view.frame(0, 0);
	enemies.clear();
	$('floorName').textContent = `${roman(n)} · ${dungeon.name.replace(/^The /, '')}`;
	await say(1);
	$('cover').classList.add('done');
	setTimeout(() => $('cover').classList.contains('done') && ($('cover').style.display = 'none'), 700);
	$('hud').classList.remove('off');
	banner(`FLOOR ${roman(n)}`, 2.4);
	audio.door();
	audio.draw();
	if (TEST) console.log('pass level-loads');
	last = performance.now();
}

function roman(n) {
	const m = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
	let s = '';
	for (const [v, c] of m) while (n >= v) {
		s += c;
		n -= v;
	}
	return s;
}

function makeShadowLights(count) {
	return Array.from({ length: count }, () => {
		const light = new PointLight(0xffffff, 0, 9, 2);
		light.castShadow = true;
		light.shadow.mapSize.set(512, 512);
		light.shadow.bias = -0.002;
		light.shadow.normalBias = 0.04;
		light.shadow.radius = 4;
		light.shadow.camera.near = 0.2;
		light.shadow.camera.far = 22;
		light.shadow.autoUpdate = false;
		view.scene.add(light);
		return { light, lamp: null, leaving: false };
	});
}

function setUpDepth() {
	const { renderer: gl, scene, camera, POST } = view;
	const target = new WebGLRenderTarget(2, 2);
	target.texture.generateMipmaps = false;
	target.texture.minFilter = NearestFilter;
	target.texture.magFilter = NearestFilter;
	const material = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
	const clear = new Color();
	POST.ao.uniforms.tZ.value = target.texture;
	POST.fin.uniforms.uAO.value = 1;
	view.beforeScene = () => {
		const w = Math.max(2, POST.w >> 1);
		const h = Math.max(2, POST.h >> 1);
		if (target.width !== w || target.height !== h) target.setSize(w, h);
		const ao = POST.ao.uniforms;
		ao.uNear.value = camera.near;
		ao.uFar.value = camera.far;
		ao.uLens.value = camera.projectionMatrix.elements[5];
		const mask = camera.layers.mask;
		const alpha = gl.getClearAlpha();
		gl.getClearColor(clear);
		scene.overrideMaterial = material;
		camera.layers.set(0);
		gl.setRenderTarget(target);
		gl.setClearColor(0xffffff, 1);
		gl.clear();
		gl.render(scene, camera);
		scene.overrideMaterial = null;
		camera.layers.mask = mask;
		gl.setClearColor(clear, alpha);
		gl.setRenderTarget(null);
	};
}

// ---------------------------------------------------------------- lamps (from the block's demo)
const LAMP_LOOK = { candle: { color: new Color(0xd8d6c8), power: 0.95 }, door: { color: new Color(0xd8d6c8), power: 0.6 }, ember: { color: new Color(0xf2b47e), power: 1.5 } };
const LAMP_FADE = [9, 13];
let lampCheck = 0;
function seesLamp(lamp, ex, ez) {
	const steps = Math.ceil(Math.hypot(lamp.x - ex, lamp.z - ez) * 3);
	for (let i = 1; i < steps; i++) {
		const t = i / steps;
		const x = Math.floor(ex + (lamp.x - ex) * t + dungeon.W / 2);
		const z = Math.floor(ez + (lamp.z - ez) * t + dungeon.H / 2);
		if (dungeon.grid[z * dungeon.W + x] !== 1) return false;
	}
	return true;
}
function placeLights(dt) {
	const ex = view.rig.eye.x / CELL_M;
	const ez = view.rig.eye.z / CELL_M;
	lampCheck -= dt;
	if (lampCheck <= 0) {
		lampCheck = 0.12;
		const score = (lamp) => {
			const dist = Math.hypot(lamp.x - ex, lamp.z - ez);
			return dist < 30 && seesLamp(lamp, ex, ez) ? dist : dist * 1.5 + 3;
		};
		const ranked = lamps.map((lamp) => ({ lamp, score: score(lamp) })).sort((a, b) => a.score - b.score);
		for (const { lamp, score: s } of ranked.slice(0, shadowLights.length)) {
			if (shadowLights.some((slot) => slot.lamp === lamp)) continue;
			const free = shadowLights.find((slot) => !slot.lamp);
			if (free) {
				free.lamp = lamp;
				free.leaving = false;
				free.light.position.set(lamp.x * CELL_M, lamp.y * CELL_M, lamp.z * CELL_M);
				free.light.color.copy(LAMP_LOOK[lamp.kind].color);
				free.light.intensity = 0;
				free.light.shadow.needsUpdate = true;
				view.renderer.shadowMap.needsUpdate = true;
				continue;
			}
			const worst = shadowLights.filter((slot) => !slot.leaving).sort((a, b) => score(b.lamp) - score(a.lamp))[0];
			if (worst && score(worst.lamp) > s + 2.5) worst.leaving = true;
		}
	}
	for (const slot of shadowLights) {
		let goal = 0;
		if (slot.lamp && !slot.leaving) {
			const dist = Math.hypot(slot.lamp.x - ex, slot.lamp.z - ez);
			const k = Math.min(1, Math.max(0, (LAMP_FADE[1] - dist) / (LAMP_FADE[1] - LAMP_FADE[0])));
			goal = LAMP_LOOK[slot.lamp.kind].power * k * k * (3 - 2 * k);
		}
		slot.light.intensity += (goal - slot.light.intensity) * Math.min(1, dt * 3);
		if (slot.leaving && slot.light.intensity < 0.015) {
			slot.lamp = null;
			slot.leaving = false;
			slot.light.intensity = 0;
		}
	}
}

// ---------------------------------------------------------------- camera
const playerFloor = () => floorAt(dungeon, walker.x + dungeon.W / 2, walker.z + dungeon.H / 2);
function syncEye(dt = 10) {
	const floor = playerFloor();
	eyeFloor += (floor - eyeFloor) * (1 - Math.exp(-dt * 11));
	const s = shake * shake;
	const jx = (Math.random() - 0.5) * s * 0.06;
	const jy = (Math.random() - 0.5) * s * 0.06;
	view.rig.eye.set(walker.x * CELL_M + jx, (eyeFloor + EYE + Math.sin(walker.bob) * 0.014) * CELL_M + jy, walker.z * CELL_M);
	view.rig.eyeYaw = walker.yaw + (Math.random() - 0.5) * s * 0.03;
	view.rig.eyePitch = walker.pitch + (Math.random() - 0.5) * s * 0.03;
	view.rig.fov = 74 + fovKick;
}
const aimDir = (out = new Vector3()) => out.set(-Math.sin(walker.yaw) * Math.cos(walker.pitch), Math.sin(walker.pitch), -Math.cos(walker.yaw) * Math.cos(walker.pitch));
function addShake(k) {
	shake = Math.min(1.2, shake + k);
	rumble(Math.min(1, k * 1.5), 100 + k * 150);
}

// ---------------------------------------------------------------- the d20
function roll() {
	const r = 1 + Math.floor(Math.random() * 20);
	const critAt = 20 - B('lucky');
	if (r >= critAt) return { r, mult: 2.5, crit: true };
	if (r === 1) return { r, mult: 0.5, fumble: true };
	return { r, mult: 0.8 + (r / 20) * 0.5 };
}
let d20T = 0;
function showD20(r, fumble) {
	const el = $('d20');
	el.querySelector('span').textContent = r;
	el.classList.toggle('fum', !!fumble);
	el.querySelector('polygon').setAttribute('fill', fumble ? '#55514a' : '#ffd27a');
	el.classList.remove('show');
	void el.offsetWidth;
	el.classList.add('show');
	d20T = 0.9;
}

// ---------------------------------------------------------------- combat
const _v = new Vector3();
function swordStrike() {
	const reach = 1.75 + B('cleave') * 0.25;
	const arc = Math.cos(((70 + B('cleave') * 20) * Math.PI) / 180);
	const fx0 = -Math.sin(walker.yaw);
	const fz0 = -Math.cos(walker.yaw);
	const r = roll();
	let any = false;
	for (const e of enemies.list) {
		if (e.dead) continue;
		const dx = e.x - walker.x;
		const dz = e.z - walker.z;
		const d = Math.hypot(dx, dz);
		if (d > reach + e.radius) continue;
		if ((dx * fx0 + dz * fz0) / (d || 1) < arc && d > 0.5) continue;
		any = true;
		const dmg = 20 * (1 + B('savage') * 0.25) * r.mult;
		const res = enemies.hurt(e, dmg, { kx: (dx / (d || 1)) * (r.crit ? 9 : 4.5), kz: (dz / (d || 1)) * (r.crit ? 9 : 4.5) });
		if (!res) continue;
		const y = res.y + e.T.height * 0.55;
		fx.sparks(e.x * CELL_M, y, e.z * CELL_M, r.crit ? 34 : 14, e.T.boss ? [3, 0.6, 0.3] : [3, 2, 1]);
		if (e.T.boss) fx.blood(e.x * CELL_M, y, e.z * CELL_M, 16, res.y);
		else fx.bones(e.x * CELL_M, y, e.z * CELL_M, 5, res.y);
		numbers.show(e.x * CELL_M, y + 0.3, e.z * CELL_M, r.crit ? `${res.dmg}!` : String(res.dmg), r.crit ? 'crit' : r.fumble ? 'fum' : '');
		if (e.T.armor > 0.15) audio.hitArmor();
		audio.hitFlesh(r.crit);
		if (B('vamp')) heal(2 * B('vamp'));
		if (res.killed) onKill(e);
		if (TEST) testPass('sword-hits');
	}
	if (any) {
		hitStop = r.crit ? 0.11 : 0.055;
		addShake(r.crit ? 0.55 : 0.22);
		if (r.crit) {
			slowMo = 0.45;
			showD20(r.r);
			audio.crit();
			flash(1, 0.82, 0.45, 0.35);
		} else if (r.fumble) {
			showD20(1, true);
			audio.fumble();
		}
	}
}

function castFire() {
	const cost = 25 * (1 - B('warcaster') * 0.25);
	if (R.mana < cost) {
		audio.fumble();
		return;
	}
	R.mana -= cost;
	weapon.cast();
	audio.fireCast();
	const d = aimDir(_v).clone();
	const eye = view.camera.position;
	const sx = eye.x + d.x * 0.5 + Math.cos(walker.yaw) * -0.25;
	const sz = eye.z + d.z * 0.5 - Math.sin(walker.yaw) * -0.25;
	const r = roll();
	fovKick = 3;
	fx.fireball(sx, eye.y - 0.2, sz, d.x, d.y, d.z, 24, (p) => explodeFire(p, r));
}

function explodeFire(p, r) {
	const radius = 2.1 + B('adept') * 0.35;
	const base = 34 * (1 + B('adept') * 0.3) * r.mult;
	fx.explosion(p.x, p.y, p.z, 1 + B('adept') * 0.15);
	audio.explode();
	const cx = p.x / CELL_M;
	const cz = p.z / CELL_M;
	const pd = Math.hypot(cx - walker.x, cz - walker.z);
	addShake(Math.max(0.15, 0.6 - pd * 0.06));
	let hitAny = false;
	for (const e of enemies.list) {
		if (e.dead) continue;
		const d = Math.hypot(e.x - cx, e.z - cz);
		if (d > radius + e.radius) continue;
		const k = 1 - Math.min(1, d / (radius + e.radius)) * 0.5;
		const res = enemies.hurt(e, base * k, { kx: ((e.x - cx) / (d || 1)) * 7, kz: ((e.z - cz) / (d || 1)) * 7, fire: true });
		if (!res) continue;
		hitAny = true;
		numbers.show(e.x * CELL_M, res.y + e.T.height * 0.7, e.z * CELL_M, r.crit ? `${res.dmg}!` : String(res.dmg), r.crit ? 'crit' : 'fire');
		if (res.killed) onKill(e);
	}
	if (hitAny && r.crit) {
		showD20(r.r);
		audio.crit();
		slowMo = 0.35;
	}
	if (hitAny && TEST) testPass('fireball-hits');
}

function fireballTest(p, b) {
	const cx = p.x / CELL_M;
	const cz = p.z / CELL_M;
	const gx = Math.floor(cx + dungeon.W / 2);
	const gz = Math.floor(cz + dungeon.H / 2);
	if (dungeon.grid[gz * dungeon.W + gx] !== 1) return true;
	const fy = floorAt(dungeon, cx + dungeon.W / 2, cz + dungeon.H / 2) * CELL_M;
	if (p.y < fy + 0.05 || p.y > fy + 6) return true;
	if (b.kind === 'bolt') {
		if (Math.hypot(cx - walker.x, cz - walker.z) < 0.35 && Math.abs(p.y - view.camera.position.y) < 1.2) {
			hitPlayer(b.owner, b.dmg, 'bolt');
			return true;
		}
		return false;
	}
	for (const e of enemies.list) {
		if (e.dead) continue;
		const ey = enemies.floorY(e.x, e.z);
		if (Math.hypot(e.x - cx, e.z - cz) < e.radius + 0.18 && p.y > ey && p.y < ey + e.T.height + 0.2) return true;
	}
	return false;
}

function shockwave() {
	if (R.waveCd > 0) return;
	R.waveCd = 8 * (1 - B('quake') * 0.25);
	const radius = 3 + B('quake') * 0.6;
	const y = playerFloor() * CELL_M;
	fx.ring(walker.x * CELL_M, y, walker.z * CELL_M, radius * CELL_M, 0xffb060, 0.55);
	fx.ring(walker.x * CELL_M, y, walker.z * CELL_M, radius * CELL_M * 0.7, 0xff7030, 0.4);
	fx.riseDust(walker.x * CELL_M, y, walker.z * CELL_M);
	fx.flashLight(walker.x * CELL_M, y + 0.6, walker.z * CELL_M, 0xffa050, 18, 0.5);
	audio.shockwave();
	addShake(0.7);
	fovKick = 6;
	for (const e of enemies.list) {
		if (e.dead) continue;
		const dx = e.x - walker.x;
		const dz = e.z - walker.z;
		const d = Math.hypot(dx, dz);
		if (d > radius) continue;
		const res = enemies.hurt(e, 22 * (1 + B('quake') * 0.3), { kx: (dx / (d || 1)) * 12, kz: (dz / (d || 1)) * 12 });
		if (!res) continue;
		numbers.show(e.x * CELL_M, res.y + e.T.height * 0.7, e.z * CELL_M, String(res.dmg), '');
		if (res.killed) onKill(e);
	}
}

function dodge(f, s) {
	if (R.dashCd > 0) return;
	R.dashCd = 0.85 * (1 - B('mobile') * 0.2);
	R.dashT = 0.2;
	R.iframes = 0.3;
	let mx = f;
	let ms = s;
	if (!mx && !ms) mx = -1;
	const l = Math.hypot(mx, ms);
	const sin = Math.sin(walker.yaw);
	const cos = Math.cos(walker.yaw);
	R.dashX = ((-sin * mx + cos * ms) / l) * 11;
	R.dashZ = ((-cos * mx - sin * ms) / l) * 11;
	fovKick = 5;
	audio.dodge();
}

function drinkPotion() {
	if (R.potions <= 0 || R.potCd > 0 || R.hp >= R.maxHp) return;
	R.potions--;
	R.potCd = 1;
	heal(45);
	audio.pickup();
	flash(0.4, 1, 0.5, 0.25);
}

function heal(n) {
	const before = R.hp;
	R.hp = Math.min(R.maxHp, R.hp + n);
	if (R.hp - before >= 5) numbers.show(walker.x * CELL_M - Math.sin(walker.yaw) * 1.2, view.camera.position.y - 0.3, walker.z * CELL_M - Math.cos(walker.yaw) * 1.2, `+${Math.round(R.hp - before)}`, 'heal');
}

function hitPlayer(e, dmg, kind) {
	if (mode !== 'play') return;
	if (R.iframes > 0) {
		if (kind !== 'bolt') numbers.show(walker.x * CELL_M - Math.sin(walker.yaw), view.camera.position.y, walker.z * CELL_M - Math.cos(walker.yaw), 'DODGED', 'xp');
		return;
	}
	R.hp -= dmg;
	R.regenDelay = 4;
	addShake(0.5);
	audio.hurt();
	$('hurt').style.transition = 'none';
	$('hurt').style.opacity = String(Math.min(1, 0.35 + dmg / 40));
	requestAnimationFrame(() => {
		$('hurt').style.transition = 'opacity .7s';
		$('hurt').style.opacity = '0';
	});
	flash(1, 0.1, 0.05, 0.25);
	if (e) {
		const dx = walker.x - e.x;
		const dz = walker.z - e.z;
		const l = Math.hypot(dx, dz) || 1;
		R.dashX = (dx / l) * 5;
		R.dashZ = (dz / l) * 5;
		R.dashT = 0.1;
	}
	if (TEST && R.hp < 30) R.hp = 30;
	if (R.hp <= 0) die();
}

let flashK = 0;
function flash(r, g, b, k) {
	view.POST.fin.uniforms.uFlashCol.value.setRGB(r, g, b);
	flashK = Math.max(flashK, k);
}

function onKill(e) {
	R.kills++;
	const xp = Math.round(e.T.xp * (1 + (R.floor - 1) * 0.2));
	numbers.show(e.x * CELL_M, enemies.floorY(e.x, e.z) + e.T.height + 0.3, e.z * CELL_M, `+${xp} XP`, 'xp');
	gainXp(xp);
	if (TEST) testPass('enemy-killed');
	if (e.T.boss) {
		R.bossAlive = false;
		$('bossbar').classList.add('off');
		banner('THE WARDEN FALLS', 3);
		audio.levelUp();
		slowMo = 1.2;
		R.potions = Math.min(5, R.potions + 1);
		openRift(e.x, e.z);
	}
	if (Math.random() < 0.06 + (e.T.armor > 0.15 ? 0.08 : 0)) {
		R.potions = Math.min(5, R.potions + 1);
		audio.pickup();
	}
}

function gainXp(n) {
	R.xp += n;
	if (R.xp >= xpNext()) {
		R.xp -= xpNext();
		R.level++;
		R.maxHp += 6;
		heal(25);
		audio.levelUp();
		setTimeout(openBoons, 450);
	}
}

// ---------------------------------------------------------------- boons
const BOONS = [
	{ k: 'savage', ic: '⚔', nm: 'Savage Attacker', ds: '+25% sword damage' },
	{ k: 'adept', ic: '🜂', nm: 'Elemental Adept', ds: 'Fire bolts hit 30% harder and burst wider' },
	{ k: 'tough', ic: '⛨', nm: 'Tough', ds: '+30 max health, fully healed', now: () => { R.maxHp += 30; R.hp = R.maxHp; } },
	{ k: 'mobile', ic: '➶', nm: 'Mobile', ds: '+12% speed, faster dodge' },
	{ k: 'arcane', ic: '✧', nm: 'Arcane Recovery', ds: 'Mana returns 40% faster' },
	{ k: 'vamp', ic: '♥', nm: 'Blood Edge', ds: 'Each sword hit heals 2' },
	{ k: 'lucky', ic: '⚀', nm: 'Lucky', ds: 'Critical hits on one more face of the d20', max: 3 },
	{ k: 'cleave', ic: '◠', nm: 'Cleave', ds: 'Wider, longer sword arc' },
	{ k: 'warcaster', ic: '✺', nm: 'War Caster', ds: 'Fire bolts cost 25% less mana' },
	{ k: 'quake', ic: '◎', nm: 'Earthshaker', ds: 'Shockwave hits harder, wider, sooner' },
];
let offered = [];
let boonSel = 0;
function openBoons() {
	if (mode !== 'play') return setTimeout(openBoons, 300);
	const pool = BOONS.filter((b) => (R.boons[b.k] ?? 0) < (b.max ?? 4));
	offered = [];
	while (offered.length < 3 && pool.length) offered.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
	const cards = $('cards');
	cards.innerHTML = '';
	offered.forEach((b, i) => {
		const c = document.createElement('div');
		c.className = 'card';
		const lv = R.boons[b.k] ?? 0;
		c.innerHTML = `<div class="ic">${b.ic}</div><div class="nm">${b.nm}${lv ? ` ${roman(lv + 1)}` : ''}</div><div class="ds">${b.ds}</div><div class="k">${i + 1}</div>`;
		c.addEventListener('click', () => pickBoon(i));
		c.addEventListener('mouseenter', () => selBoon(i));
		cards.appendChild(c);
	});
	selBoon(0);
	mode = 'boons';
	$('boons').classList.remove('off');
	document.exitPointerLock?.();
}
function selBoon(i) {
	boonSel = (i + offered.length) % offered.length;
	[...$('cards').children].forEach((c, j) => c.classList.toggle('sel', j === boonSel));
}
function pickBoon(i) {
	const b = offered[i];
	if (!b) return;
	R.boons[b.k] = (R.boons[b.k] ?? 0) + 1;
	b.now?.();
	audio.pickup();
	$('boons').classList.add('off');
	mode = 'play';
	lockPointer();
	last = performance.now();
}

// ---------------------------------------------------------------- rooms and encounters
function roomCells(r) {
	const out = [];
	const W = dungeon.W;
	for (let y = Math.floor(r.cy - r.h / 2); y <= Math.ceil(r.cy + r.h / 2); y++) for (let x = Math.floor(r.cx - r.w / 2); x <= Math.ceil(r.cx + r.w / 2); x++) {
		const c = y * W + x;
		if (dungeon.roomId[c] === r.id && dungeon.walkable[c] && dungeon.grid[c] === 1) out.push({ x: x + 0.5 - W / 2, z: y + 0.5 - dungeon.H / 2 });
	}
	return out;
}

function pickType(elite) {
	const f = R.floor;
	const r = Math.random();
	if (r < (elite ? 0.35 : 0.1 + f * 0.05)) return 'revenant';
	if (r < (elite ? 0.55 : 0.26 + f * 0.04)) return 'wisp';
	return 'hollow';
}

function wake(room) {
	R.active.add(room.id);
	const cells = roomCells(room).filter((c) => Math.hypot(c.x - walker.x, c.z - walker.z) > 2.2);
	if (!cells.length) {
		R.cleared.add(room.id);
		return;
	}
	const f = R.floor;
	let n = room.type === 'elite' ? 5 + f : room.type === 'boss' ? 2 + Math.floor(f / 2) : 3 + Math.floor(f * 0.8) + Math.floor(Math.random() * 2);
	n = Math.max(1, Math.min(n, 12 - enemies.alive));
	if (room.type === 'boss') {
		const mid = cells.reduce((a, c) => (Math.hypot(c.x - (room.cx + 0.5 - dungeon.W / 2), c.z - (room.cy + 0.5 - dungeon.H / 2)) < Math.hypot(a.x - (room.cx + 0.5 - dungeon.W / 2), a.z - (room.cy + 0.5 - dungeon.H / 2)) ? c : a));
		const boss = enemies.spawn('ogre', mid.x, mid.z, { roomId: room.id, level: f });
		R.boss = boss;
		R.bossAlive = true;
		$('bossName').textContent = `WARDEN OF ${dungeon.name.split(' of ').pop().toUpperCase()}`;
		$('bossbar').classList.remove('off');
		audio.roar();
		addShake(0.6);
		banner('', 0);
	}
	R.pending[room.id] = n;
	const floorAtWake = R.floor;
	for (let i = 0; i < n; i++) {
		const c = cells[Math.floor(Math.random() * cells.length)];
		setTimeout(() => {
			R.pending[room.id]--;
			if (!enemies || mode === 'loading' || R.floor !== floorAtWake) return;
			enemies.spawn(pickType(room.type === 'elite'), c.x + (Math.random() - 0.5) * 0.4, c.z + (Math.random() - 0.5) * 0.4, { roomId: room.id, level: f });
			if (TEST) testPass('enemy-rises');
		}, i * 260 + Math.random() * 200);
	}
	audio.rise();
	audio.door();
}

function ambush() {
	const n = Math.min(10 - enemies.alive, 2 + Math.floor(R.floor / 2) + (Math.random() < 0.4 ? 1 : 0));
	for (let i = 0; i < n; i++) {
		const s = enemies.findSpot(walker.x, walker.z, 3.5, 7.5);
		if (!s) continue;
		setTimeout(() => enemies && mode !== 'loading' && enemies.spawn(pickType(false), s.x, s.z, { level: R.floor }), i * 300);
	}
	audio.rise();
}

function updateRooms(dt) {
	const room = walker.room();
	if (room && !R.cleared.has(room.id) && !R.active.has(room.id)) {
		if (room.type === 'combat' || room.type === 'elite' || room.type === 'boss') wake(room);
		else if (room.type === 'shrine') {
			R.cleared.add(room.id);
			heal(R.maxHp);
			R.mana = R.maxMana;
			banner('SHRINE · RESTORED', 1.8);
			audio.levelUp();
			flash(0.5, 1, 0.9, 0.3);
		} else if (room.type === 'treasure') {
			R.cleared.add(room.id);
			R.potions = Math.min(5, R.potions + 2);
			banner('TREASURE · +2 POTIONS', 1.8);
			audio.pickup();
			gainXp(25);
		} else R.cleared.add(room.id);
	}
	for (const id of R.active) {
		if (R.pending[id] > 0 || enemies.list.some((e) => e.roomId === id && !e.dead)) continue;
		R.active.delete(id);
		R.cleared.add(id);
		if (dungeon.rooms[id].type !== 'boss') {
			heal(8);
			gainXp(10);
		}
	}
	// Quiet halls don't stay quiet.
	R.ambushT -= dt;
	if (R.ambushT <= 0) {
		R.ambushT = 16 + Math.random() * 10 - Math.min(8, R.floor * 1.5);
		if (enemies.alive < 3 && !R.bossAlive) ambush();
	}
	if (R.bossAlive && R.boss) {
		$('bossbar').querySelector('i').style.transform = `scaleX(${Math.max(0, R.boss.hp / R.boss.maxHp)})`;
		$('bossbar').querySelector('b').style.transform = `scaleX(${Math.max(0, R.boss.hp / R.boss.maxHp)})`;
		R.bossAdds = (R.bossAdds ?? 10) - dt;
		if (R.bossAdds <= 0) {
			R.bossAdds = 11;
			if (enemies.alive < 6) ambush();
		}
	}
}

// The way down: a burning ring that opens where the warden fell.
function openRift(x, z) {
	const y = enemies.floorY(x, z);
	const mat = new ShaderMaterial({
		vertexShader: 'varying vec2 vU; void main(){ vU=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
		fragmentShader: 'uniform float uT; varying vec2 vU; void main(){ float a=vU.x*6.2832; float n=sin(a*7.0+uT*3.0)*0.5+sin(a*13.0-uT*5.0)*0.5; float h=vU.y; float k=pow(1.0-h,2.0)*(0.6+0.4*n); gl_FragColor=vec4(vec3(3.0,1.1,0.3)*k, k); }',
		uniforms: { uT: { value: 0 } },
		transparent: true,
		depthWrite: false,
		blending: AdditiveBlending,
		side: DoubleSide,
	});
	const m = new Mesh(new CylinderGeometry(1.1, 1.1, 3.2, 48, 1, true), mat);
	m.position.set(x * CELL_M, y + 1.6, z * CELL_M);
	view.scene.add(m);
	const light = fx.flashLight(x * CELL_M, y + 1, z * CELL_M, 0xff7a30, 14, 1e6);
	rift = { x, z, m, mat, light, t: 0 };
	banner('THE WAY DOWN IS OPEN', 2.5);
}

// ---------------------------------------------------------------- flow
function lockPointer() {
	if (TEST || !canvas || lastDevice === 'pad') return;
	try {
		const p = canvas.requestPointerLock();
		p?.catch?.(() => {});
	} catch {}
}
function onMouseDown(e) {
	lastDevice = 'kb';
	audio.resume();
	if (mode === 'title') return start();
	if (mode === 'pause') return resumePlay();
	if (mode === 'dead') return deadReady && restart();
	if (mode !== 'play') return;
	if (document.pointerLockElement !== canvas) return lockPointer();
	if (e.button === 0) {
		mouse.l = true;
		mouse.lPressed = true;
	}
	if (e.button === 2) {
		mouse.r = true;
		mouse.rPressed = true;
	}
}
addEventListener('mouseup', (e) => {
	if (e.button === 0) mouse.l = false;
	if (e.button === 2) mouse.r = false;
});
for (const id of ['title', 'pause', 'dead']) $(id).addEventListener('mousedown', (e) => onMouseDown(e));
$('title').addEventListener('contextmenu', (e) => e.preventDefault());

function start() {
	$('title').classList.add('off');
	$('hud').classList.remove('off');
	mode = 'play';
	audio.resume();
	lockPointer();
	last = performance.now();
}
function pausePlay() {
	if (mode !== 'play') return;
	mode = 'pause';
	keys.clear();
	mouse.l = mouse.r = false;
	$('pause').classList.remove('off');
	if (document.pointerLockElement) document.exitPointerLock();
}
function resumePlay() {
	$('pause').classList.add('off');
	mode = 'play';
	lockPointer();
	last = performance.now();
}
let deadReady = false;
function die() {
	mode = 'dead';
	R.hp = 0;
	slowMo = 0;
	$('sFloor').textContent = R.floor;
	$('sKills').textContent = R.kills;
	$('sLvl').textContent = R.level;
	const s = Math.floor(R.t);
	$('sTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	deadReady = false;
	setTimeout(() => {
		if (mode !== 'dead') return;
		$('dead').classList.remove('off');
		deadReady = true;
	}, 900);
	document.exitPointerLock?.();
}
async function restart() {
	deadReady = false;
	$('dead').classList.add('off');
	newRun();
	await buildFloor(1);
	mode = 'play';
	lockPointer();
}
async function descend() {
	mode = 'descend';
	R.floor++;
	await buildFloor(R.floor);
	mode = 'play';
	lockPointer();
}

let bannerT = 0;
function banner(text, dur) {
	if (!text) return;
	$('banner').querySelector('.t').textContent = text;
	$('banner').style.opacity = '1';
	bannerT = dur;
}

// ---------------------------------------------------------------- input
addEventListener('keydown', (e) => {
	lastDevice = 'kb';
	audio.resume();
	if (e.repeat) return;
	keys.add(e.code);
	if (mode === 'title' && (e.code === 'Space' || e.code === 'Enter')) return start();
	if (mode === 'boons') {
		if (e.code.startsWith('Digit')) pickBoon(Number(e.code.slice(5)) - 1);
		if (e.code === 'ArrowLeft' || e.code === 'KeyA') selBoon(boonSel - 1);
		if (e.code === 'ArrowRight' || e.code === 'KeyD') selBoon(boonSel + 1);
		if (e.code === 'Enter' || e.code === 'Space') pickBoon(boonSel);
		return;
	}
	if (e.code === 'KeyP') return mode === 'pause' ? resumePlay() : pausePlay();
	if (e.code === 'KeyM') audio.toggle();
	if (mode !== 'play') return;
	if (e.code === 'Space') dodge(axisF(), axisS());
	if (e.code === 'KeyQ') shockwave();
	if (e.code === 'KeyE') drinkPotion();
	if (e.code === 'KeyF') mouse.rPressed = true;
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => {
	keys.clear();
	if (!TEST) pausePlay();
});
addEventListener('resize', () => view?.resize());
document.addEventListener('pointerlockchange', () => {
	if (!document.pointerLockElement && mode === 'play' && !TEST) pausePlay();
});
addEventListener('mousemove', (e) => {
	if (document.pointerLockElement !== canvas || mode !== 'play') return;
	lookX += e.movementX;
	lookY += e.movementY;
});
const axisF = () => (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) + pad.f;
const axisS = () => (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + pad.s;

// Controllers, standard mapping.
const pad = { f: 0, s: 0, lx: 0, ly: 0, prev: [], down: [], pressed: [] };
const dz = (x, y) => {
	const l = Math.hypot(x, y);
	if (l < 0.15) return [0, 0];
	const k = Math.min(1, (l - 0.15) / 0.85) / l;
	return [x * k, y * k];
};
function readPad() {
	pad.f = pad.s = pad.lx = pad.ly = 0;
	pad.pressed = [];
	const p = [...(navigator.getGamepads?.() ?? [])].find((g) => g && g.mapping === 'standard');
	if (!p || TEST) return;
	const down = p.buttons.map((b) => b.pressed || b.value > 0.5);
	pad.pressed = down.map((d, i) => d && !pad.prev[i]);
	pad.prev = down;
	pad.down = down;
	const [mx, my] = dz(p.axes[0], p.axes[1]);
	const [lx, ly] = dz(p.axes[2], p.axes[3]);
	pad.s = mx;
	pad.f = -my;
	pad.lx = Math.sign(lx) * lx * lx;
	pad.ly = Math.sign(ly) * ly * ly;
	if (pad.pressed.some(Boolean) || Math.hypot(p.axes[0], p.axes[1]) > 0.5 || Math.hypot(p.axes[2], p.axes[3]) > 0.5) {
		if (lastDevice !== 'pad') {
			lastDevice = 'pad';
			$('goTxt').textContent = 'Press any button';
		}
		audio.resume();
	}
	padRef = p;
}
let padRef = null;
function rumble(strong, ms) {
	padRef?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: strong * 0.6 })?.catch?.(() => {});
}
function padMenus() {
	const P = pad.pressed;
	if (!P.length) return;
	if (mode === 'title' && P.some(Boolean)) return start();
	if (mode === 'pause' && (P[0] || P[9])) return resumePlay();
	if (mode === 'dead' && P[0] && deadReady) return restart();
	if (mode === 'boons') {
		if (P[14]) selBoon(boonSel - 1);
		if (P[15]) selBoon(boonSel + 1);
		if (P[0]) pickBoon(boonSel);
	}
	if (mode === 'play' && P[9]) pausePlay();
}

// ---------------------------------------------------------------- the frame
let frameAvg = 16;
let resT = 0;
let skipRender = false;
// The GPU's own time for a frame, where the browser offers it: the only honest gauge on a 60 Hz screen.
const gpu = { ext: null, gl: null, q: [], ms: 0, n: 0 };
let frameNo = 0;
function renderView(t, dt) {
	if (skipRender) return;
	frameNo++;
	if (!gpu.gl || gpu.gl !== view.renderer.getContext()) {
		gpu.gl = view.renderer.getContext();
		gpu.ext = gpu.gl.getExtension('EXT_disjoint_timer_query_webgl2');
		gpu.q = [];
		gpu.n = 0;
	}
	const { gl, ext } = gpu;
	const timed = ext && frameNo % 6 === 0 && gpu.q.length < 4;
	let q = null;
	if (timed) {
		q = gl.createQuery();
		gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
	}
	view.frame(t, dt);
	if (q) {
		gl.endQuery(ext.TIME_ELAPSED_EXT);
		gpu.q.push(q);
	}
	while (ext && gpu.q.length && gl.getQueryParameter(gpu.q[0], gl.QUERY_RESULT_AVAILABLE)) {
		const done = gpu.q.shift();
		if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
			const ms = gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6;
			gpu.ms = gpu.n++ ? gpu.ms + (ms - gpu.ms) * 0.2 : ms;
		}
		gl.deleteQuery(done);
	}
}
function tick(now) {
	requestAnimationFrame(tick);
	const raw = Math.min(100, now - last);
	last = now;
	frame(raw);
}
function frame(raw) {
	readPad();
	padMenus();
	if (!view || mode === 'loading' || mode === 'descend') return;
	// A frame over 50 ms means the page was held back (hidden, busy), not that the picture is too heavy.
	if (raw < 50) frameAvg += (raw - frameAvg) * 0.05;
	adaptResolution(raw / 1000);
	let dt = Math.min(raw / 1000, 0.05);
	if (mode === 'title' || mode === 'pause' || mode === 'boons' || mode === 'dead') {
		// Idle sway while menus are up, so the crypt is alive behind them.
		if (mode === 'title') walker.yaw += dt * 0.04;
		syncEye(dt);
		placeLights(dt);
		if (mode === 'dead') enemies.update(dt, walker, hooks);
		fx.update(dt, pxScale(), fireballTest);
		weapon.update(dt, { aspect: view.rig.aspect, moving: false, speed: 0, time, mana: R.mana / R.maxMana });
		numbers.update(dt, view.camera, innerWidth, innerHeight);
		renderView(time, dt);
		return;
	}
	// Hit-stop and slow motion bend game time; the camera and UI keep real time.
	const realDt = dt;
	if (hitStop > 0) {
		hitStop -= realDt;
		dt *= 0.05;
	} else if (slowMo > 0) {
		slowMo -= realDt;
		dt *= 0.3;
	}
	time += dt;
	R.t += realDt;
	play(dt, realDt);
	renderView(time, dt);
}

const hooks = {
	hitPlayer: (e, dmg) => hitPlayer(e, dmg),
	whiff: () => audio.swing(3),
	slam(e, radius) {
		const y = enemies.floorY(e.x, e.z);
		const fx0 = e.x + Math.sin(e.yaw) * 1.2;
		const fz0 = e.z + Math.cos(e.yaw) * 1.2;
		fx.ring(fx0 * CELL_M, y, fz0 * CELL_M, radius * CELL_M, 0xff5030, 0.5);
		fx.riseDust(fx0 * CELL_M, y, fz0 * CELL_M);
		fx.sparks(fx0 * CELL_M, y + 0.1, fz0 * CELL_M, 30, [3, 1, 0.4], 7);
		audio.shockwave();
		const pd = Math.hypot(walker.x - fx0, walker.z - fz0);
		addShake(Math.max(0.2, 0.9 - pd * 0.1));
		if (pd < radius) hitPlayer(e, Math.round(e.dmg * 1.3));
	},
	telegraph(e, radius) {
		const y = enemies.floorY(e.x, e.z);
		fx.ring((e.x + Math.sin(e.yaw) * 1.2) * CELL_M, y, (e.z + Math.cos(e.yaw) * 1.2) * CELL_M, radius * CELL_M, 0x801808, 0.9);
		audio.roar();
	},
	charge(e) {
		audio.bolt();
	},
	windup(e) {
		if (e.type === 'revenant') audio.swing(2);
	},
	bolt(e) {
		const y = e.root.position.y + 1.35;
		const tx = walker.x * CELL_M;
		const tz = walker.z * CELL_M;
		const ty = view.camera.position.y - 0.25;
		const sx = e.x * CELL_M + Math.sin(e.yaw) * 0.25;
		const sz = e.z * CELL_M + Math.cos(e.yaw) * 0.25;
		const d = new Vector3(tx - sx, ty - y, tz - sz).normalize();
		fx.bolt(sx, y, sz, d.x, d.y, d.z, 11, null);
		const b = fxLastBall();
		if (b) {
			b.owner = e;
			b.dmg = e.dmg;
		}
		audio.bolt();
	},
};
// The bolt just made is the last in fx's list; fx keeps them private, so reach it through a tiny hook.
function fxLastBall() {
	return fx._lastBall;
}

function pxScale() {
	return (0.5 * view.renderer.domElement.height) / Math.tan((view.camera.fov * Math.PI) / 360);
}

let stepT = 0;
function play(dt, realDt) {
	const f = Math.max(-1, Math.min(1, axisF()));
	const s = Math.max(-1, Math.min(1, axisS()));
	// Look.
	const k = LOOK * (view.rig.fov / 72);
	walker.yaw -= lookX * k;
	walker.pitch = Math.max(-1.3, Math.min(1.3, walker.pitch - lookY * k));
	lookX = lookY = 0;
	walker.yaw -= pad.lx * 3.2 * realDt;
	walker.pitch = Math.max(-1.3, Math.min(1.3, walker.pitch - pad.ly * 2.2 * realDt));
	// Actions.
	const P = pad.pressed;
	if (TEST) autopilot(dt);
	if (mouse.lPressed || P[7] || P[5]) {
		const n = weapon.attack(1 + B('mobile') * 0.05);
		if (n >= 0) audio.swing(n);
	}
	if ((mouse.l || pad.down[7]) && !weapon.swinging) {
		const n = weapon.attack(1);
		if (n >= 0) audio.swing(n);
	}
	if (mouse.rPressed || P[6]) castFire();
	if (P[0]) dodge(f, s);
	if (P[2] || P[4]) shockwave();
	if (P[3]) drinkPotion();
	mouse.lPressed = mouse.rPressed = false;

	// Move.
	const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') || pad.down[10];
	const speed = (sprint ? RUN : WALK) * (1 + B('mobile') * 0.12) * (weapon.swinging ? 0.8 : 1);
	if (R.dashT > 0) {
		R.dashT -= dt;
		walker.step(dt, 0, 0, 0);
		walker.vx = R.dashX;
		walker.vz = R.dashZ;
		walker.step(dt, 0, 0, 0);
		walker.vx = R.dashX;
		walker.vz = R.dashZ;
	} else walker.step(dt, f, s, speed);
	// Enemies push back.
	for (const e of enemies.list) {
		if (e.dead) continue;
		const dx = walker.x - e.x;
		const dz = walker.z - e.z;
		const d = Math.hypot(dx, dz);
		const rr = e.radius + 0.28;
		if (d < rr && d > 1e-4) {
			walker.x = e.x + (dx / d) * rr;
			walker.z = e.z + (dz / d) * rr;
		}
	}
	walker.step(0.0001, 0, 0, 0);
	if (walker.speedNow > 1.5) {
		stepT -= dt * walker.speedNow;
		if (stepT <= 0) {
			stepT = 2.2;
			audio.step();
		}
	}

	// Timers.
	R.dashCd = Math.max(0, R.dashCd - dt);
	R.waveCd = Math.max(0, R.waveCd - dt);
	R.potCd = Math.max(0, R.potCd - dt);
	R.iframes = Math.max(0, R.iframes - dt);
	R.mana = Math.min(R.maxMana, R.mana + dt * 13 * (1 + B('arcane') * 0.4));
	R.regenDelay -= dt;
	if (R.regenDelay <= 0 && R.hp < R.maxHp * 0.35) R.hp = Math.min(R.maxHp * 0.35, R.hp + dt * 2);
	shake = Math.max(0, shake - realDt * 2.2);
	fovKick *= Math.exp(-realDt * 6);
	if (flashK > 0) {
		flashK = Math.max(0, flashK - realDt * 1.6);
		view.POST.fin.uniforms.uFlash.value = flashK;
	}

	const ev = weapon.update(realDt * (hitStop > 0 ? 0.15 : 1), { aspect: view.rig.aspect, moving: walker.speedNow > 0.5, speed: walker.speedNow, time, mana: Math.min(1, R.mana / 25) });
	if (ev === 'strike') swordStrike();
	enemies.update(dt, walker, hooks);
	updateRooms(dt);
	fx.update(dt, pxScale(), fireballTest);
	if (rift) {
		rift.t += dt;
		rift.mat.uniforms.uT.value = rift.t;
		if (Math.random() < 0.6) fx.soul(rift.x * CELL_M, enemies.floorY(rift.x, rift.z), rift.z * CELL_M, [2.5, 0.9, 0.3]);
		if (Math.hypot(walker.x - rift.x, walker.z - rift.z) < 1.1) {
			descend();
			return;
		}
	}
	syncEye(realDt);
	placeLights(dt);
	numbers.update(realDt, view.camera, innerWidth, innerHeight);
	audio.setCombat(enemies.alive > 0 ? 1 : 0, realDt);
	hud(realDt);
}

// ---------------------------------------------------------------- HUD
let hpShown = 1;
function hud(dt) {
	const hp = Math.max(0, R.hp / R.maxHp);
	$('hp').querySelector('i').style.transform = `scaleX(${hp})`;
	hpShown += (hp - hpShown) * Math.min(1, dt * 2.5);
	$('hp').querySelector('b').style.transform = `scaleX(${Math.max(hp, hpShown)})`;
	$('mp').querySelector('i').style.transform = `scaleX(${R.mana / R.maxMana})`;
	$('xp').querySelector('i').style.transform = `scaleX(${R.xp / xpNext()})`;
	$('lvl').textContent = R.level;
	$('hpTxt').textContent = `${Math.ceil(Math.max(0, R.hp))} / ${R.maxHp}`;
	$('lowhp').style.opacity = hp < 0.3 ? String(0.5 + Math.sin(time * 6) * 0.3) : '0';
	const cd = (id, v) => $(id).querySelector('.cd').style.setProperty('--p', `${Math.round(v * 100)}%`);
	cd('abDash', R.dashCd / (0.85 * (1 - B('mobile') * 0.2)));
	cd('abWave', R.waveCd / (8 * (1 - B('quake') * 0.25)));
	cd('abPot', R.potCd);
	$('abFire').classList.toggle('low', R.mana < 25 * (1 - B('warcaster') * 0.25));
	$('abPot').classList.toggle('low', R.potions === 0);
	$('potN').textContent = R.potions;
	// Compass: the next room that still holds the dead, on the way to the warden; then the rift.
	let goal = null;
	if (rift) goal = { x: rift.x, z: rift.z };
	else {
		for (const id of dungeon.path) {
			if (R.cleared.has(id)) continue;
			const r = dungeon.rooms[id];
			goal = { x: r.cx + 0.5 - dungeon.W / 2, z: r.cy + 0.5 - dungeon.H / 2 };
			break;
		}
	}
	if (goal) {
		const a = Math.atan2(-(goal.x - walker.x), -(goal.z - walker.z));
		let rel = a - walker.yaw;
		rel = Math.atan2(Math.sin(rel), Math.cos(rel));
		const x = 50 - (rel / (Math.PI / 2)) * 50;
		$('goal').style.left = `${Math.max(0, Math.min(100, x))}%`;
		$('goal').style.opacity = Math.abs(rel) > Math.PI / 2 ? '0.35' : '1';
	} else $('goal').style.opacity = '0';
	if (bannerT > 0) {
		bannerT -= dt;
		if (bannerT <= 0) $('banner').style.opacity = '0';
	}
}

// Holds the frame rate: the picture gets a little softer before it ever stutters, and sharpens again when there's room.
let resScale = 1;
let calm = 0;
let probeWait = 0;
function adaptResolution(dt) {
	resT += dt;
	if (resT < 0.5) return;
	resT = 0;
	let down;
	let up;
	if (gpu.ext && gpu.n > 4) {
		down = gpu.ms > 14.5;
		up = gpu.ms < 10.5;
	} else {
		// No GPU clock: step down when frames run long, and after a long quiet spell try a little sharper.
		down = frameAvg > 18.5;
		probeWait -= 0.5;
		up = frameAvg < 17.4 && probeWait <= 0;
	}
	if (down && resScale > 0.6) {
		resScale = Math.max(0.6, resScale - 0.08);
		calm = 0;
		probeWait = 20;
		view.setResScale(resScale);
	} else if (up && resScale < 1) {
		if (++calm >= 6) {
			resScale = Math.min(1, resScale + 0.04);
			calm = 3;
			view.setResScale(resScale);
		}
	} else calm = 0;
}

window.patch?.addEventListener?.('qualitychange', () => {
	quality = window.patch.quality;
	const Q = LOOKS[quality] ?? LOOKS.high;
	view?.setPixelBudget(Q.budget);
	view?.setPixelCap(Q.cap);
});

// ---------------------------------------------------------------- Patch's test: a short autopilot
const passed = new Set();
function testPass(name) {
	if (passed.has(name)) return;
	passed.add(name);
	console.log(`pass ${name}`);
}
let apT = 0;
function autopilot(dt) {
	apT += dt;
	if (apT < 1) return;
	R.testSpawnT = (R.testSpawnT ?? 0) - dt;
	if (enemies.alive === 0 && passed.size < 5 && R.testSpawnT <= 0) {
		R.testSpawnT = 2;
		for (let i = 0; i < 3; i++) {
			const s = enemies.findSpot(walker.x, walker.z, 2.5, 4.5);
			if (s) enemies.spawn('hollow', s.x, s.z, { level: 1 });
		}
		testPass('enemy-rises');
	}
	const target = enemies.list.filter((e) => !e.dead).sort((a, b) => Math.hypot(a.x - walker.x, a.z - walker.z) - Math.hypot(b.x - walker.x, b.z - walker.z))[0];
	if (!target) return;
	const want = Math.atan2(-(target.x - walker.x), -(target.z - walker.z));
	let d = want - walker.yaw;
	d = Math.atan2(Math.sin(d), Math.cos(d));
	walker.yaw += d * Math.min(1, dt * 8);
	walker.pitch *= 0.9;
	const dist = Math.hypot(target.x - walker.x, target.z - walker.z);
	if (Math.abs(d) < 0.3) {
		if (!passed.has('fireball-hits') && R.mana >= 25 && Math.random() < dt * 2) mouse.rPressed = true;
		else if (dist < 1.6) mouse.lPressed = true;
	}
	if (dist > 1.3) keys.add('KeyW');
	else keys.delete('KeyW');
}

// ---------------------------------------------------------------- go
(async function boot() {
	newRun();
	try {
		await buildFloor(1);
	} catch (e) {
		console.error(e);
		$('cover').innerHTML = `<div class="go">${e?.message ?? e}</div>`;
		if (TEST) console.log(`fail level-loads: ${e?.message ?? e}`);
		return;
	}
	if (TEST) {
		$('title').classList.add('off');
		mode = 'play';
	} else {
		mode = 'title';
		$('title').classList.remove('off');
		$('hud').classList.add('off');
	}
	last = performance.now();
	requestAnimationFrame(tick);
	if (params.has('debug')) {
		window.__g = {
			R,
			get enemies() {
				return enemies;
			},
			get walker() {
				return walker;
			},
			get dungeon() {
				return dungeon;
			},
			get view() {
				return view;
			},
			get fx() {
				return fx;
			},
			get rift() {
				return rift;
			},
			get mode() {
				return mode;
			},
			start,
			// Runs n frames of 1/60 s at once, drawing only the last.
			step(n = 60) {
				skipRender = true;
				for (let i = 0; i < n; i++) {
					if (i === n - 1) skipRender = false;
					frame(1000 / 60);
				}
				skipRender = false;
				last = performance.now();
			},
			press(code) {
				if (code === 'LMB') mouse.lPressed = true;
				else if (code === 'RMB') mouse.rPressed = true;
				else dispatchEvent(new KeyboardEvent('keydown', { code }));
			},
			look(yaw, pitch = 0) {
				walker.yaw = yaw;
				walker.pitch = pitch;
			},
		};
	}
})();
