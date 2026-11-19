// Scripted party companions: host-run, no LLM. Positions are in cells, centred like enemies (grid cell = x + W/2).
// Pure logic first (field, target pick, step) so the sim test can run it without a browser.

const FLOOR = 1;
const NB4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// Multi-source BFS over floor cells. src: cell indices (or -1 to skip). dist is filled with -1 where unreached.
export function bfsField(grid, W, H, src, n, dist, queue, maxD = 60) {
	dist.fill(-1);
	let qh = 0;
	let qt = 0;
	for (let i = 0; i < n; i++) {
		const s = src[i];
		if (s < 0 || dist[s] !== -1) continue;
		dist[s] = 0;
		queue[qt++] = s;
	}
	while (qh < qt) {
		const c = queue[qh++];
		const cx = c % W;
		const cy = (c / W) | 0;
		const dv = dist[c];
		if (dv >= maxD) continue;
		for (let k = 0; k < 4; k++) {
			const nx = cx + NB4[k][0];
			const ny = cy + NB4[k][1];
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			const m = ny * W + nx;
			if (dist[m] !== -1 || grid[m] !== FLOOR) continue;
			dist[m] = dv + 1;
			queue[qt++] = m;
		}
	}
	return qt;
}

// World (centred) position -> cell index, or -1 when off the map.
export function cellOf(W, H, x, z) {
	const cx = Math.floor(x + W / 2);
	const cy = Math.floor(z + H / 2);
	return cx < 0 || cy < 0 || cx >= W || cy >= H ? -1 : cy * W + cx;
}

// Nearest alive target, sticky: keep `cur` unless something is clearly closer.
export function pickTarget(tg, n, x, z, cur, stick = 1.35) {
	let best = null;
	let bd = Infinity;
	for (let i = 0; i < n; i++) {
		const t = tg[i];
		if (!t.alive) continue;
		const d = Math.hypot(t.x - x, t.z - z);
		if (d < bd) {
			bd = d;
			best = t;
		}
	}
	if (best && cur && cur !== best) {
		for (let i = 0; i < n; i++) {
			if (tg[i] !== cur || !cur.alive) continue;
			if (Math.hypot(cur.x - x, cur.z - z) <= bd * stick + 0.5) return cur;
		}
	}
	return best;
}

// Next waypoint down the distance field from (x,z): writes out.x/out.z and returns true when it found a step.
export function stepDown(grid, W, H, dist, x, z, out) {
	const cx = Math.floor(x + W / 2);
	const cy = Math.floor(z + H / 2);
	if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
	let best = dist[cy * W + cx];
	if (best < 0) best = 9999;
	let found = false;
	for (let k = 0; k < 8; k++) {
		const ox = NB8[k][0];
		const oy = NB8[k][1];
		const nx = cx + ox;
		const ny = cy + oy;
		if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
		const dv = dist[ny * W + nx];
		if (dv < 0 || dv >= best) continue;
		if (ox && oy && (grid[cy * W + nx] !== FLOOR || grid[ny * W + cx] !== FLOOR)) continue;
		best = dv;
		out.x = nx + 0.5 - W / 2;
		out.z = ny + 0.5 - H / 2;
		found = true;
	}
	return found;
}

export const NAMES = ['Sir Aldric', 'Dame Maren', 'Brother Tobin', 'Lady Isolde', 'Ser Corvin', 'Hild the Grim', 'Wick', 'Oswin', 'Mother Edda', 'Ser Brannoch', 'Ravel'];
export const ANIM = { idle: 0, walk: 1, attack: 2, cast: 3, down: 4 };

const ENGAGE = 7;
const REACH = 1.5;
const BOLT_MIN = 2.8;
const SWORD_CD = 0.9;
const BOLT_CD = 3.5;
const SPEED = 3.1;
const REVIVE_T = 20;
const FOLLOW_FAR = 3;
const FOLLOW_NEAR = 2.2;

export function createCompanions({ dungeon: d, enemies, fx, audio, floorY }) {
	const { W, H, grid } = d;
	const list = [];
	const dist = new Int16Array(W * H);
	const near = new Int16Array(W * H);
	const queue = new Int32Array(W * H);
	const src = new Int32Array(16);
	const wp = { x: 0, z: 0 };
	const tg = [];
	let fieldT = 0;
	let seq = 0;
	const fy = floorY || ((x, z) => enemies.floorY(x, z));
	const passable = (x, z) => {
		const i = cellOf(W, H, x, z);
		return i >= 0 && grid[i] === FLOOR && d.walkable[i] === 1;
	};
	const clear = (x0, z0, x1, z1) => {
		const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 3);
		for (let i = 1; i < steps; i++) {
			const t = i / steps;
			if (!passable(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false;
		}
		return true;
	};
	function walk(b, dx, dz) {
		const r = 0.25;
		const nx = b.x + dx;
		if (passable(nx + Math.sign(dx) * r, b.z)) b.x = nx;
		const nz = b.z + dz;
		if (passable(b.x, nz + Math.sign(dz) * r)) b.z = nz;
	}
	function face(b, tx, tz) {
		// Same convention as the walker: forward is (-sin yaw, -cos yaw).
		b.yaw = Math.atan2(-(tx - b.x), -(tz - b.z));
	}
	function moveTo(b, tx, tz, dt, sp = SPEED) {
		let mx = tx - b.x;
		let mz = tz - b.z;
		const l = Math.hypot(mx, mz) || 1;
		mx /= l;
		mz /= l;
		// Keep off other companions.
		for (const o of list) {
			if (o === b || o.state === 'down') continue;
			const ox = b.x - o.x;
			const oz = b.z - o.z;
			const q = ox * ox + oz * oz;
			if (q < 0.64 && q > 1e-6) {
				const ql = Math.sqrt(q);
				mx += (ox / ql) * (0.8 - ql) * 2;
				mz += (oz / ql) * (0.8 - ql) * 2;
			}
		}
		walk(b, mx * sp * dt, mz * sp * dt);
		face(b, b.x + mx, b.z + mz);
		b.anim = ANIM.walk;
	}
	// Walk toward a point: straight when the line is clear, else down the field to the humans.
	function approach(b, tx, tz, dt, useField) {
		if (clear(b.x, b.z, tx, tz)) moveTo(b, tx, tz, dt);
		else if (useField && stepDown(grid, W, H, dist, b.x, b.z, wp)) moveTo(b, wp.x, wp.z, dt);
		else moveTo(b, tx, tz, dt);
	}
	function nearestEnemy(x, z, range) {
		let best = null;
		let bd = range;
		for (const e of enemies.list) {
			if (e.dead || e.state === 'rise') continue;
			const dd = Math.hypot(e.x - x, e.z - z);
			if (dd < bd) {
				bd = dd;
				best = e;
			}
		}
		if (best) best._bd = bd;
		return best;
	}
	function roll() {
		const r = 1 + Math.floor(Math.random() * 20);
		if (r >= 20) return { r, mult: 2.5, crit: true };
		if (r === 1) return { r, mult: 0.5, fumble: true };
		return { r, mult: 0.8 + (r / 20) * 0.5 };
	}
	function sword(b, e) {
		const r = roll();
		const dx = e.x - b.x;
		const dz = e.z - b.z;
		const dd = Math.hypot(dx, dz) || 1;
		const res = enemies.hurt(e, 15 * r.mult, { kx: (dx / dd) * (r.crit ? 8 : 4), kz: (dz / dd) * (r.crit ? 8 : 4) });
		b.anim = ANIM.attack;
		b.animT = 0.35;
		if (res) {
			fx?.sparks?.(e.x * 1.5, res.y + e.T.height * 0.55, e.z * 1.5, r.crit ? 30 : 12, [3, 2, 1]);
			audio?.hitFlesh?.(r.crit);
		} else audio?.swing?.(3);
		b.cd = SWORD_CD * (0.9 + Math.random() * 0.3);
	}
	function bolt(b, e) {
		const M = 1.5;
		const sx = b.x * M;
		const sz = b.z * M;
		const sy = fy(b.x, b.z) + 1.3;
		const dx = (e.x - b.x) * M;
		const dz = (e.z - b.z) * M;
		const dy = fy(e.x, e.z) + e.T.height * 0.55 - sy;
		const l = Math.hypot(dx, dy, dz) || 1;
		const r = roll();
		face(b, e.x, e.z);
		b.anim = ANIM.cast;
		b.animT = 0.5;
		b.boltCd = BOLT_CD * (0.9 + Math.random() * 0.4);
		audio?.fireCast?.();
		fx?.fireball?.(sx, sy, sz, dx / l, dy / l, dz / l, 20, (p) => {
			fx.explosion?.(p.x, p.y, p.z, 0.8);
			audio?.explode?.();
			const cx = p.x / M;
			const cz = p.z / M;
			for (const t of enemies.list) {
				if (t.dead) continue;
				const q = Math.hypot(t.x - cx, t.z - cz);
				if (q > 1.8 + t.radius) continue;
				enemies.hurt(t, 24 * r.mult * (1 - Math.min(1, q / 3.6) * 0.5), { kx: ((t.x - cx) / (q || 1)) * 6, kz: ((t.z - cz) / (q || 1)) * 6, fire: true });
			}
		});
	}
	function setDown(b) {
		b.state = 'down';
		b.hp = 0;
		b.downT = 0;
		b.anim = ANIM.down;
	}
	function revive(b) {
		b.state = 'follow';
		b.hp = Math.round(b.maxHp * 0.5);
		b.cd = 1;
		b.anim = ANIM.idle;
	}

	function tick(b, dt, humans, hn) {
		b.cd -= dt;
		b.boltCd -= dt;
		if (b.animT > 0) b.animT -= dt;
		if (b.state === 'down') {
			b.downT += dt;
			if (!nearestEnemy(b.x, b.z, 10) || b.downT >= REVIVE_T) revive(b);
			return;
		}
		if (b.hp <= 0) return setDown(b);
		if (b.animT <= 0) b.anim = ANIM.idle;
		let h = null;
		let hd = Infinity;
		for (let i = 0; i < hn; i++) {
			const t = humans[i];
			if (!t.alive) continue;
			const q = Math.hypot(t.x - b.x, t.z - b.z);
			if (q < hd) {
				hd = q;
				h = t;
			}
		}
		const e = nearestEnemy(b.x, b.z, ENGAGE);
		const ed = e ? e._bd : Infinity;
		const low = b.hp < b.maxHp * 0.3;
		if (low) b.state = 'retreat';
		else if (b.state === 'retreat' && b.hp >= b.maxHp * 0.5) b.state = 'follow';
		if (b.state === 'retreat') {
			if (e && ed < 5) {
				const ax = b.x - e.x;
				const az = b.z - e.z;
				const l = Math.hypot(ax, az) || 1;
				// Flee away from the enemy, but toward the humans if one is near enough to cover.
				const tx = h && hd > 2 ? h.x : b.x + ax / l;
				const tz = h && hd > 2 ? h.z : b.z + az / l;
				moveTo(b, b.x + (ax / l) * 2 + (tx - b.x) * 0.3, b.z + (az / l) * 2 + (tz - b.z) * 0.3, dt, SPEED * 1.1);
			} else {
				b.hp = Math.min(b.maxHp, b.hp + dt * 4);
				if (h && hd > FOLLOW_FAR) approach(b, h.x, h.z, dt, true);
			}
			return;
		}
		b.state = 'follow';
		// Stay on a leash: past 12 cells from every human, ignore enemies and catch up.
		if (e && hd < 12) {
			b.state = 'engage';
			face(b, e.x, e.z);
			if (ed < REACH + e.radius) {
				if (b.cd <= 0) sword(b, e);
			} else if (ed >= BOLT_MIN && b.boltCd <= 0 && clear(b.x, b.z, e.x, e.z)) bolt(b, e);
			else approach(b, e.x, e.z, dt, !!h);
			return;
		}
		if (h && hd > FOLLOW_FAR) approach(b, h.x, h.z, dt, true);
		else if (h && hd < FOLLOW_NEAR && hd > 0.01) {
			// Too close: drift back so the human is not crowded.
			moveTo(b, b.x + (b.x - h.x), b.z + (b.z - h.z), dt, SPEED * 0.5);
		}
	}

	function spawnNear(b, ax, az) {
		const s = cellOf(W, H, ax, az);
		src[0] = s;
		bfsField(grid, W, H, src, 1, near, queue, 4);
		let best = -1;
		let bestScore = Infinity;
		for (let i = 0; i < W * H; i++) {
			const dv = near[i];
			if (dv < 2 || dv > 4 || d.walkable[i] !== 1) continue;
			const x = (i % W) + 0.5 - W / 2;
			const z = ((i / W) | 0) + 0.5 - H / 2;
			let crowd = 0;
			for (const o of list) if (o !== b && Math.hypot(o.x - x, o.z - z) < 1.1) crowd += 5;
			const sc = crowd + Math.abs(dv - 3) + Math.random() * 0.5;
			if (sc < bestScore) {
				bestScore = sc;
				best = i;
			}
		}
		if (best < 0) {
			b.x = ax;
			b.z = az;
		} else {
			b.x = (best % W) + 0.5 - W / 2;
			b.z = ((best / W) | 0) + 0.5 - H / 2;
		}
	}

	const api = {
		list,
		setCount(n, around) {
			n = Math.max(0, Math.min(11, n | 0));
			while (list.length > n) list.pop();
			while (list.length < n) {
				const k = seq++;
				const b = { id: `bot:${k}`, name: NAMES[k % NAMES.length], x: 0, z: 0, y: 0, yaw: 0, pitch: 0, anim: 0, hp: 100, maxHp: 100, state: 'follow', cd: 0.5, boltCd: 1 + Math.random() * 2, downT: 0, animT: 0 };
				if (around) spawnNear(b, around.x, around.z);
				list.push(b);
				b.y = fy(b.x, b.z);
			}
			tg.length = list.length;
			for (let i = 0; i < list.length; i++) tg[i] = tg[i] || { id: '', x: 0, z: 0, alive: true };
		},
		update(dt, humans) {
			const hn = humans.length;
			fieldT -= dt;
			if (fieldT <= 0) {
				fieldT = 0.4;
				let n = 0;
				for (let i = 0; i < hn && n < 16; i++) if (humans[i].alive) src[n++] = cellOf(W, H, humans[i].x, humans[i].z);
				bfsField(grid, W, H, src, n, dist, queue, 40);
			}
			for (const b of list) {
				tick(b, dt, humans, hn);
				b.y = fy(b.x, b.z);
			}
		},
		// Enemies call this (via hooks.hitActor) when they hit 'bot:N'. Returns true if a bot took it.
		hit(id, dmg) {
			for (const b of list) {
				if (b.id !== id) continue;
				if (b.state === 'down') return false;
				b.hp -= dmg;
				if (b.hp <= 0) setDown(b);
				return true;
			}
			return false;
		},
		// Feed this to enemies.setTargets alongside the humans (same pooled objects every call).
		targets() {
			for (let i = 0; i < list.length; i++) {
				const t = tg[i];
				t.id = list[i].id;
				t.x = list[i].x;
				t.z = list[i].z;
				t.alive = list[i].state !== 'down';
			}
			return tg;
		},
		states() {
			return list.map((b) => ({ id: b.id, x: b.x, z: b.z, y: b.y, yaw: b.yaw, pitch: 0, anim: b.anim, hp: Math.max(0, Math.round(b.hp)), name: b.name }));
		},
	};
	return api;
}
