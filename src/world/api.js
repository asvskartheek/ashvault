// The Dungeon Master's hands: one method per op in src/dm/schema.js. Effect ops run everywhere; HOST_ONLY ops change shared state and do
// nothing on a client (it gets their result through snapshot()/restore()). No three.js import, so the pure parts run in Node.
import { COLORS, HOST_ONLY, ROLES } from '../dm/schema.js';

const CELL_M = 1.5;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hexInt = (name) => parseInt((COLORS[name] ?? COLORS.bone).slice(1), 16);
const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
// Each mood: exposure and fog multipliers, a grade tint, and a fog colour pulled in by `mix`.
const MOOD = {
	still: { exposure: 1, fog: 1, grade: [1, 1, 1], fogHex: 0, mix: 0 },
	tense: { exposure: 0.92, fog: 1.25, grade: [1, 0.97, 0.95], fogHex: 0, mix: 0 },
	grim: { exposure: 0.8, fog: 1.5, grade: [0.92, 1, 0.9], fogHex: 0x0a140a, mix: 0.35 },
	warm: { exposure: 1.12, fog: 0.9, grade: [1.1, 1, 0.88], fogHex: 0x2a1408, mix: 0.25 },
	cold: { exposure: 0.95, fog: 1.1, grade: [0.86, 0.98, 1.15], fogHex: 0x0c1826, mix: 0.3 },
	wrath: { exposure: 1.05, fog: 1.35, grade: [1.25, 0.8, 0.75], fogHex: 0x2a0606, mix: 0.5 },
};
const MAX_LIGHT_SLOTS = 2; // fx's pool has 4 lights shared with fireballs; the DM keeps at most 2 of them burning
const MAX_LIGHTS = 8;
const TIMER_NAMES = ['haste', 'ward', 'dark', 'poison', 'slow', 'frenzy'];

export function createWorldAPI(deps) {
	const { view, dungeon, enemies, fx, audio, hud, R } = deps;
	const quests = deps.quests;
	const lights = new Map(); // room -> { color, power, fade, follow, slot }
	const sealed = new Set();
	const roles = new Map(); // rooms the DM re-roled
	const timers = Object.fromEntries(TIMER_NAMES.map((k) => [k, 0]));
	let moodName = 'still';
	let musicTrack = null;
	let palette = 'verdant';
	let poisonAcc = 0;
	// Where the look is now (it eases toward the mood's goal): exposure, fog, grade rgb, fog colour rgb (linear) and its mix.
	const cur = { exposure: 1, fog: 1, grade: [1, 1, 1], fogRgb: [0, 0, 0], mix: 0 };
	const room = (i) => dungeon?.rooms?.[i];
	const locked = (r) => !r || r.type === 'entrance' || r.type === 'boss';
	const hostOnly = (op) => HOST_ONLY.has(op) && !deps.authority; // read live: host migration flips it

	function roomPos(r) {
		return { x: (r.cx + 0.5 - dungeon.W / 2) * CELL_M, y: 2.1, z: (r.cy + 0.5 - dungeon.H / 2) * CELL_M };
	}

	function claimSlots() {
		const mine = [...lights.values()].slice(-MAX_LIGHT_SLOTS);
		for (const L of lights.values()) {
			if (mine.includes(L)) continue;
			if (L.slot && L.slot.follow === L.follow) L.slot.life = 0;
			L.slot = null;
		}
		for (const L of mine) {
			// fx may have lent the slot to a fireball since: take one back.
			if (!L.slot || L.slot.follow !== L.follow) L.slot = fx?.flashLight?.(L.follow.x, L.follow.y, L.follow.z, hexInt(L.color), 0, 1e9, L.follow) ?? null;
			if (L.slot) {
				L.slot.peak = 6 * L.power * L.fade;
				L.slot.life = L.slot.max = 1e9;
			}
		}
	}

	function applyGrade() {
		const look = view?.look;
		if (look) {
			look.exposure = cur.exposure;
			look.fog = cur.fog;
			look.fogMix = cur.mix;
			[look.fogColor.r, look.fogColor.g, look.fogColor.b] = cur.fogRgb;
		}
		const g = view?.POST?.fin?.uniforms?.uGrade?.value;
		if (g) [g.r, g.g, g.b] = cur.grade;
	}

	function goal() {
		const M = MOOD[moodName] ?? MOOD.still;
		const dark = timers.dark > 0 ? 1 : 0;
		const rgb = [(M.fogHex >> 16) & 255, (M.fogHex >> 8) & 255, M.fogHex & 255].map(lin);
		return { exposure: M.exposure * (dark ? 0.6 : 1), fog: M.fog * (dark ? 1.8 : 1), grade: M.grade, fogRgb: rgb, mix: M.mix };
	}

	const world = {
		get mods() {
			return { speed: (timers.haste > 0 ? 1.35 : 1) * (timers.slow > 0 ? 0.7 : 1), taken: timers.ward > 0 ? 0.6 : 1, enemySpeed: timers.frenzy > 0 ? 1.35 : 1 };
		},
		timers,
		sealed,
		isSealed: (i) => sealed.has(i),
		get mood() {
			return moodName;
		},
		get music() {
			return musicTrack;
		},

		role(i, as) {
			const r = room(i);
			if (hostOnly('role') || locked(r) || !ROLES.includes(as)) return;
			r.type = as;
			roles.set(i, as);
		},
		guard(i, enemy, n, level = 0) {
			const r = room(i);
			if (hostOnly('guard') || locked(r)) return;
			r.roster = [{ enemy, n: clamp(n | 0, 1, 8), level: clamp(level | 0, 0, 4) }];
		},
		spawn(enemy, n, { near = 'party', room: ri, level = 0 } = {}) {
			if (hostOnly('spawn') || !deps.spawnAt) return;
			let cells = [];
			const party = deps.partyPos?.();
			if (near === 'room' && room(ri)) cells = deps.roomCells(room(ri));
			else if (party) {
				for (const r of dungeon.rooms) if (Math.hypot(r.cx + 0.5 - dungeon.W / 2 - party.x, r.cy + 0.5 - dungeon.H / 2 - party.z) < 22) cells.push(...deps.roomCells(r));
				const far = cells.filter((c) => Math.hypot(c.x - party.x, c.z - party.z) > 4);
				if (far.length) cells = far;
			} else if (room(ri)) cells = deps.roomCells(room(ri));
			if (!cells.length) return;
			for (let k = 0; k < clamp(n | 0, 1, 6); k++) {
				const c = cells[Math.floor(Math.random() * cells.length)];
				deps.spawnAt(enemy, c.x + (Math.random() - 0.5) * 0.4, c.z + (Math.random() - 0.5) * 0.4, { roomId: ri, level });
			}
		},
		light(i, color, power = 1) {
			const r = room(i);
			if (!r || !COLORS[color]) return;
			const p = clamp(+power || 0, 0, 3);
			const old = lights.get(i);
			if (old?.slot && old.slot.follow === old.follow) old.slot.life = 0;
			lights.delete(i);
			if (p <= 0) return;
			const pos = roomPos(r);
			lights.set(i, { color, power: p, fade: old ? old.fade : 0, follow: Object.assign({ x: pos.x, y: pos.y, z: pos.z }, { position: null }), slot: null }); // fx copies follow.position
			const L = lights.get(i);
			L.follow.position = L.follow;
			while (lights.size > MAX_LIGHTS) lights.delete(lights.keys().next().value);
			claimSlots();
		},
		mood(as) {
			if (MOOD[as]) moodName = as;
		},
		sfx(cue, ri) {
			let vol = 1;
			const party = deps.partyPos?.();
			const r = room(ri);
			if (r && party) vol = clamp(1 - Math.hypot(r.cx + 0.5 - dungeon.W / 2 - party.x, r.cy + 0.5 - dungeon.H / 2 - party.z) / 40, 0.25, 1);
			audio?.cue?.(cue, { vol });
		},
		music(track) {
			musicTrack = track;
			audio?.music?.(track);
		},
		bless(what, amount = 20, who = 'all', actorId) {
			if (hostOnly('bless')) return;
			if (deps.relay?.('bless', { what, amount, who, actorId })) return; // a remote actor: net sends it on
			const n = clamp(+amount || 0, 1, 100);
			const secs = clamp(n * 0.3, 6, 30);
			if (what === 'heal') deps.heal ? deps.heal(n) : (R.hp = Math.min(R.maxHp, R.hp + n));
			else if (what === 'mana') R.mana = Math.min(R.maxMana, R.mana + n);
			else if (what === 'potion') R.potions += Math.max(1, Math.round(n / 25));
			else if (what === 'xp') deps.addXp ? deps.addXp(n) : (R.xp += n);
			else if (what === 'haste') timers.haste = Math.max(timers.haste, secs);
			else if (what === 'ward') timers.ward = Math.max(timers.ward, secs);
			audio?.cue?.('levelUp', { vol: 0.5 });
		},
		curse(what, secs = 10, who = 'all', actorId) {
			if (hostOnly('curse') || !(what in timers)) return;
			if (deps.relay?.('curse', { what, secs, who, actorId })) return;
			timers[what] = Math.max(timers[what], clamp(+secs || 0, 3, 60));
		},
		seal(i, open = false) {
			if (hostOnly('seal') || !room(i)) return;
			if (open) sealed.delete(i);
			else sealed.add(i);
		},
		say(text, voice = 'dm') {
			hud?.say?.(text, voice);
		},
		quest(q) {
			if (hostOnly('quest')) return;
			quests?.add?.(q);
		},

		update(dt) {
			// Lights fade in.
			for (const L of lights.values()) L.fade = Math.min(1, L.fade + dt / 1.6);
			if (lights.size) claimSlots();
			// The mood, and the dark curse, ease toward their goal.
			const G = goal();
			const k = 1 - Math.exp(-dt * 1.2);
			cur.exposure += (G.exposure - cur.exposure) * k;
			cur.fog += (G.fog - cur.fog) * k;
			cur.mix += (G.mix - cur.mix) * k;
			for (let i = 0; i < 3; i++) {
				cur.grade[i] += (G.grade[i] - cur.grade[i]) * k;
				cur.fogRgb[i] += (G.fogRgb[i] - cur.fogRgb[i]) * k;
			}
			applyGrade();
			// Blessings and curses run down.
			for (const n of TIMER_NAMES) if (timers[n] > 0) timers[n] = Math.max(0, timers[n] - dt);
			if (timers.poison > 0) {
				poisonAcc += dt * 1.5;
				if (poisonAcc >= 1) {
					const hit = Math.floor(poisonAcc);
					poisonAcc -= hit;
					if (deps.hurt) deps.hurt(hit, 'poison');
					else R.hp = Math.max(1, R.hp - hit);
				}
			} else poisonAcc = 0;
		},

		// What persists, for a late joiner: small JSON.
		snapshot() {
			return {
				l: [...lights].map(([i, L]) => [i, L.color, +L.power.toFixed(2)]),
				m: moodName,
				mu: musicTrack,
				s: [...sealed],
				r: [...roles],
				c: Object.fromEntries(TIMER_NAMES.filter((n) => timers[n] > 0).map((n) => [n, Math.round(timers[n])])),
				p: palette,
			};
		},
		restore(s) {
			if (!s || typeof s !== 'object') return;
			for (const [i, color, power] of s.l ?? []) {
				world.light(i, color, power);
				const L = lights.get(i);
				if (L) L.fade = 1;
			}
			if (s.m) world.mood(s.m);
			if (s.mu) world.music(s.mu);
			sealed.clear();
			for (const i of s.s ?? []) if (room(i)) sealed.add(i);
			for (const [i, as] of s.r ?? []) if (room(i) && !locked(room(i)) && ROLES.includes(as)) {
				room(i).type = as;
				roles.set(i, as);
			}
			for (const [n, secs] of Object.entries(s.c ?? {})) if (n in timers) timers[n] = +secs || 0;
			if (s.p) world.applyPalette(s.p);
		},
		applyPalette(name) {
			palette = name;
			view?.applyPalette?.(name);
		},
	};
	return world;
}
