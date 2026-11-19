// Remote players and bots: a tinted knight each, a name tag, and a ~100 ms interpolation buffer so 10-12 Hz state looks smooth.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { CELL_M } from '../dungeon/view.js';

const DELAY = 100; // ms behind the newest state
const HEIGHT = 1.85;
const ANIM = { idle: 'Idle', walk: 'Run', attack: 'Attack', attack2: 'Kick', hit: 'Hit', slam: 'Attack', taunt: 'Idle' };
const ONCE = ['attack', 'attack2', 'hit', 'slam'];
const PALETTE = [0x4aa3ff, 0xff5a4a, 0x5adf7a, 0xffc94a, 0xb06cff, 0xff8a3a, 0x3ad8d0, 0xff6ab8, 0xa6d83a, 0x8a9bff, 0xe8e0c8, 0xc0722a];
const hash = (s) => {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
};
const lerpAngle = (a, b, k) => a + (b - a - Math.PI * 2 * Math.round((b - a) / (Math.PI * 2))) * k;

function tagSprite(name, color) {
	const c = document.createElement('canvas');
	c.width = 256;
	c.height = 64;
	const g = c.getContext('2d');
	g.font = 'bold 30px sans-serif';
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	g.lineWidth = 6;
	g.strokeStyle = 'rgba(0,0,0,0.85)';
	g.strokeText(name, 128, 32);
	g.fillStyle = '#' + color.getHexString();
	g.fillText(name, 128, 32);
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	const m = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, fog: false });
	const s = new THREE.Sprite(m);
	s.scale.set(1.1, 0.275, 1);
	s.renderOrder = 10;
	return s;
}

export function createAvatars({ scene, assets, env, floorY = () => 0 } = {}) {
	const src = assets.knight;
	const box = new THREE.Box3().setFromObject(src.scene, true);
	const scale = HEIGHT / Math.max(0.01, box.max.y - box.min.y);
	const clips = Object.fromEntries(src.animations.map((a) => [a.name, a]));
	if (!clips.Kick) clips.Kick = clips.Attack;
	const list = new Map();
	const api = { floorY };

	function make(id, name, color, bot) {
		const col = new THREE.Color(color ?? PALETTE[hash(id) % PALETTE.length]);
		const root = SkeletonUtils.clone(src.scene);
		root.scale.setScalar(scale);
		root.traverse((o) => {
			if (!o.isMesh) return;
			o.frustumCulled = false;
			const m = (o.material = o.material.clone());
			m.color.copy(col).lerp(new THREE.Color(0.5, 0.5, 0.5), 0.45);
			m.roughness = 0.45;
			m.metalness = Math.min(m.metalness ?? 1, 0.6);
			if (env) m.envMap = env;
			m.emissiveMap = m.map;
			m.emissive = col.clone().multiplyScalar(0.16);
		});
		const holder = new THREE.Group();
		holder.add(root);
		const mixer = new THREE.AnimationMixer(root);
		const actions = {};
		for (const [k, n] of Object.entries(ANIM)) if (clips[n]) actions[k] = mixer.clipAction(clips[n]);
		for (const k of ONCE) if (actions[k]) (actions[k].setLoop(THREE.LoopOnce, 1), (actions[k].clampWhenFinished = true));
		const tag = tagSprite(bot ? `${name} (AI)` : name, col);
		tag.position.y = HEIGHT + 0.45;
		holder.add(tag);
		scene.add(holder);
		return { id, holder, root, mixer, actions, tag, buf: [], cur: null, anim: '', dieT: -1, name, bot, pos: null };
	}

	function play(a, name) {
		if (a.anim === name) return;
		a.anim = name;
		if (name === 'die') {
			a.dieT = 0;
			a.cur?.fadeOut(0.2);
			return;
		}
		a.dieT = -1;
		a.root.rotation.x = 0;
		const act = a.actions[name] || a.actions.idle;
		if (!act) return;
		act.reset().setEffectiveWeight(1).play();
		if (name === 'walk') act.timeScale = 1.05;
		if (a.cur && a.cur !== act) a.cur.crossFadeTo(act, 0.15, false);
		a.cur = act;
	}

	// state: { x, z (cells), y (feet, m; optional), yaw, pitch, anim, hp }
	api.upsert = (id, s, { name = id, color, bot = false } = {}) => {
		let a = list.get(id);
		if (!a) {
			a = make(id, name, color, bot);
			list.set(id, a);
		}
		a.buf.push({ t: performance.now(), x: s.x, z: s.z, y: Number.isFinite(s.y) ? s.y : null, yaw: s.yaw || 0, anim: s.anim || 'idle', hp: s.hp });
		if (a.buf.length > 12) a.buf.shift();
	};
	api.remove = (id) => {
		const a = list.get(id);
		if (!a) return;
		scene.remove(a.holder);
		a.mixer.stopAllAction();
		a.holder.traverse((o) => {
			if (o.isMesh) o.material.dispose();
			if (o.isSprite) (o.material.map.dispose(), o.material.dispose());
		});
		list.delete(id);
	};
	api.clear = () => {
		for (const id of [...list.keys()]) api.remove(id);
	};
	api.has = (id) => list.has(id);
	api.position = (id) => list.get(id)?.pos || null; // metres {x,y,z}, for aiming/pings

	api.update = (dt) => {
		const rt = performance.now() - DELAY;
		for (const a of list.values()) {
			const b = a.buf;
			if (!b.length) continue;
			let i = b.length - 1;
			while (i > 0 && b[i].t > rt) i--;
			const p0 = b[i];
			const p1 = b[i + 1] || p0;
			const k = p1 === p0 ? 0 : Math.min(1, Math.max(0, (rt - p0.t) / (p1.t - p0.t)));
			const x = p0.x + (p1.x - p0.x) * k;
			const z = p0.z + (p1.z - p0.z) * k;
			const y0 = p0.y ?? floorY(p0.x, p0.z);
			const y1 = p1.y ?? floorY(p1.x, p1.z);
			const y = y0 + (y1 - y0) * k;
			const yaw = lerpAngle(p0.yaw, p1.yaw, k);
			const moving = (p1.x - p0.x) ** 2 + (p1.z - p0.z) ** 2 > 1e-6;
			const anim = (k > 0.5 ? p1 : p0).anim;
			play(a, anim === 'idle' && moving ? 'walk' : anim);
			a.holder.position.set(x * CELL_M, y, z * CELL_M);
			a.root.rotation.y = yaw;
			a.pos = { x: x * CELL_M, y, z: z * CELL_M };
			if (a.dieT >= 0) {
				a.dieT = Math.min(1, a.dieT + dt / 0.6);
				a.root.rotation.x = -a.dieT * (Math.PI / 2) * 0.95;
				a.root.position.y = a.dieT * 0.18;
			} else a.root.position.y = 0;
			a.mixer.update(dt);
			while (b.length > 2 && b[1].t < rt) b.shift();
		}
	};
	return api;
}
