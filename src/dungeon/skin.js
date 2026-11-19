// The level's stone as continuous surfaces, instead of a cube for each cell: a wall that wraps the open floor with its corners worn
// round and its foot flaring into the floor, a floor with real relief, and rounded tunnel vaults over the corridors. Relief comes from
// the same height maps the textures use, so the geometry and the picture agree. All in the view's cells, cut into chunks that can be culled.
import * as THREE from 'three';
import { bedAt, rampAt } from './floors.js';

const RES = 5; // Field samples a cell.
const CHUNK = 14; // Cells a chunk.
const WALL_STEP = 0.22; // Cells between wall vertices, both ways.

function makeNoise(seed) {
	const h = (x, y) => {
		const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
		return s - Math.floor(s);
	};
	return (x, y) => {
		const ix = Math.floor(x);
		const iy = Math.floor(y);
		const fx = x - ix;
		const fy = y - iy;
		const ux = fx * fx * (3 - 2 * fx);
		const uy = fy * fy * (3 - 2 * fy);
		const a = h(ix, iy);
		const b = h(ix + 1, iy);
		const c = h(ix, iy + 1);
		const d = h(ix + 1, iy + 1);
		return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
	};
}

/** A height map's picture, shrunk so it's already blurred to the scale geometry can follow. Sampled by tiling uv. */
export function heightSampler(image, size = 96) {
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	ctx.drawImage(image, 0, 0, size, size);
	const data = ctx.getImageData(0, 0, size, size).data;
	const at = (x, y) => data[(((y % size) + size) % size) * size * 4 + ((((x % size) + size) % size) * 4)] / 255;
	return (u, v) => {
		const x = u * size;
		const y = (1 - v) * size;
		const ix = Math.floor(x);
		const iy = Math.floor(y);
		const fx = x - ix;
		const fy = y - iy;
		return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
	};
}

/** The open floor as a soft field: 1 well inside, 0 in the rock, with a wandering edge. */
function openField(d) {
	const w = d.W * RES + 1;
	const h = d.H * RES + 1;
	let f = new Float32Array(w * h);
	const open = (cx, cy) => {
		if (cx < 0 || cy < 0 || cx >= d.W || cy >= d.H) return false;
		const g = d.grid[cy * d.W + cx];
		return g === 1 || g === 3;
	};
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const a = open(Math.floor((x - 0.5) / RES), Math.floor((y - 0.5) / RES));
		const b = open(Math.floor((x + 0.5) / RES), Math.floor((y - 0.5) / RES));
		const c = open(Math.floor((x - 0.5) / RES), Math.floor((y + 0.5) / RES));
		const e = open(Math.floor((x + 0.5) / RES), Math.floor((y + 0.5) / RES));
		f[y * w + x] = (a + b + c + e) / 4;
	}
	const blur = (src, r) => {
		const a = new Float32Array(w * h);
		const b = new Float32Array(w * h);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			let s = 0;
			for (let k = -r; k <= r; k++) s += src[y * w + Math.max(0, Math.min(w - 1, x + k))];
			a[y * w + x] = s / (2 * r + 1);
		}
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			let s = 0;
			for (let k = -r; k <= r; k++) s += a[Math.max(0, Math.min(h - 1, y + k)) * w + x];
			b[y * w + x] = s / (2 * r + 1);
		}
		return b;
	};
	f = blur(blur(f, 2), 2);
	// Blurring closes anything narrow: a one-cell doorway would have a wall across it that you could walk straight through. So what can be
	// walked stays open, right along each cell and across to any open neighbour.
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const px = x / RES;
		const py = y / RES;
		const cx = Math.floor(px);
		const cy = Math.floor(py);
		if (!open(cx, cy)) continue;
		const lx = px - cx;
		const ly = py - cy;
		const inX = (lx >= 0.16 || open(cx - 1, cy)) && (lx <= 0.84 || open(cx + 1, cy));
		const inY = (ly >= 0.16 || open(cx, cy - 1)) && (ly <= 0.84 || open(cx, cy + 1));
		if (inX && inY) f[y * w + x] = Math.max(f[y * w + x], 0.74);
	}
	f = blur(f, 1);
	const noise = makeNoise(5);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const cx = x / RES;
		const cy = y / RES;
		out[y * w + x] = f[y * w + x] + (noise(cx * 0.9, cy * 0.9) - 0.5) * 0.16 + (noise(cx * 3.1, cy * 3.1) - 0.5) * 0.05;
	}
	return { f: out, soft: f, w, h };
}

export function fieldAt(field, cx, cy, key = 'f') {
	const { w, h } = field;
	const src = field[key];
	const x = Math.max(0, Math.min(w - 1.001, cx * RES));
	const y = Math.max(0, Math.min(h - 1.001, cy * RES));
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const ax = x - ix;
	const ay = y - iy;
	const a = src[iy * w + ix];
	const b = src[iy * w + ix + 1];
	const c = src[(iy + 1) * w + ix];
	const e = src[(iy + 1) * w + ix + 1];
	return a + (b - a) * ax + (c - a) * ay + (a - b - c + e) * ax * ay;
}

/** Closed outlines of the open floor, walked so the open side is on the left. */
function outlines(field) {
	const { f, w, h } = field;
	const ISO = 0.5;
	const edgePoint = (ax, ay, bx, by) => {
		const va = f[ay * w + ax];
		const vb = f[by * w + bx];
		const t = (ISO - va) / (vb - va || 1e-5);
		return [(ax + (bx - ax) * t) / RES, (ay + (by - ay) * t) / RES];
	};
	const next = new Map();
	const points = new Map();
	const hEdge = (x, y) => (y * w + x) * 2;
	const vEdge = (x, y) => (y * w + x) * 2 + 1;
	const link = (a, b) => {
		if (!points.has(a[0])) points.set(a[0], a[1]);
		if (!points.has(b[0])) points.set(b[0], b[1]);
		next.set(a[0], b[0]);
	};
	for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
		const c0 = f[y * w + x] >= ISO;
		const c1 = f[y * w + x + 1] >= ISO;
		const c2 = f[(y + 1) * w + x + 1] >= ISO;
		const c3 = f[(y + 1) * w + x] >= ISO;
		const code = (c0 ? 1 : 0) | (c1 ? 2 : 0) | (c2 ? 4 : 0) | (c3 ? 8 : 0);
		if (code === 0 || code === 15) continue;
		const top = () => [hEdge(x, y), edgePoint(x, y, x + 1, y)];
		const right = () => [vEdge(x + 1, y), edgePoint(x + 1, y, x + 1, y + 1)];
		const bottom = () => [hEdge(x, y + 1), edgePoint(x, y + 1, x + 1, y + 1)];
		const left = () => [vEdge(x, y), edgePoint(x, y, x, y + 1)];
		switch (code) {
			case 1: link(top(), left()); break;
			case 2: link(right(), top()); break;
			case 3: link(right(), left()); break;
			case 4: link(bottom(), right()); break;
			case 5: link(top(), right()); link(bottom(), left()); break;
			case 6: link(bottom(), top()); break;
			case 7: link(bottom(), left()); break;
			case 8: link(left(), bottom()); break;
			case 9: link(top(), bottom()); break;
			case 10: link(left(), top()); link(right(), bottom()); break;
			case 11: link(right(), bottom()); break;
			case 12: link(left(), right()); break;
			case 13: link(top(), right()); break;
			case 14: link(left(), top()); break;
			default: break;
		}
	}
	const seen = new Set();
	const loops = [];
	for (const start of next.keys()) {
		if (seen.has(start)) continue;
		const loop = [];
		let k = start;
		while (k !== undefined && !seen.has(k)) {
			seen.add(k);
			loop.push(points.get(k));
			k = next.get(k);
		}
		if (loop.length > 12) loops.push(loop);
	}
	return loops;
}

function resample(loop, step) {
	// Relax it first: the grid's stair-steps go, and the corners stay worn round.
	let pts = loop;
	for (let pass = 0; pass < 3; pass++) {
		const n = pts.length;
		pts = pts.map((p, i) => {
			const a = pts[(i + n - 1) % n];
			const b = pts[(i + 1) % n];
			return [(a[0] + p[0] * 2 + b[0]) / 4, (a[1] + p[1] * 2 + b[1]) / 4];
		});
	}
	const out = [];
	let carry = 0;
	const n = pts.length;
	for (let i = 0; i < n; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % n];
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		let at = step - carry;
		while (at <= len) {
			const t = at / len;
			out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
			at += step;
		}
		carry = (carry + len) % step;
	}
	return out;
}

class Chunks {
	constructor() {
		this.map = new Map();
	}

	at(x, z, make) {
		const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
		if (!this.map.has(key)) this.map.set(key, make());
		return this.map.get(key);
	}
}

/** The wall: an outline swept up to whatever ceiling it meets. */
export function wallGeometry(d, field, ceilingAt, heightOf) {
	const chunks = new Chunks();
	const noise = makeNoise(11);
	const ox = -d.W / 2;
	const oz = -d.H / 2;
	const make = () => ({ pos: [], nor: [], s: [], tan: [], idx: [] });
	for (const raw of outlines(field)) {
		const loop = resample(raw, WALL_STEP);
		const n = loop.length;
		if (n < 6) continue;
		// Make sure it faces the open floor: the sweep below faces left of the walking direction.
		{
			let facing = 0;
			for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 24))) {
				const p = loop[i];
				const b = loop[(i + 1) % n];
				const tx = b[0] - p[0];
				const tz = b[1] - p[1];
				const l = Math.hypot(tx, tz) || 1;
				facing += fieldAt(field, p[0] + (tz / l) * 0.3, p[1] - (tx / l) * 0.3) - fieldAt(field, p[0] - (tz / l) * 0.3, p[1] + (tx / l) * 0.3);
			}
			if (facing < 0) loop.reverse();
		}
		const rows = [];
		let arc = 0;
		for (let i = 0; i <= n; i++) {
			const p = loop[i % n];
			const a = loop[(i + n - 1) % n];
			const b = loop[(i + 1) % n];
			const tx = b[0] - a[0];
			const tz = b[1] - a[1];
			const tl = Math.hypot(tx, tz) || 1;
			rows.push({ x: p[0], z: p[1], tx: tx / tl, tz: tz / tl, s: arc });
			arc += WALL_STEP;
		}
		// A loop has to end where it began, or a crack runs from floor to vault where it closes: its length is stretched to a whole
		// number of stone tiles, and the wandering fades into how it started.
		const length = n * WALL_STEP;
		const stretch = Math.max(1, Math.round(length * 0.75)) / (length * 0.75);
		for (const q of rows) q.s *= stretch;
		const closed = length * stretch;
		const wanderAt = (s, y) => (noise(s * 0.55, y * 0.75) - 0.5) * 0.09 + (noise(s * 1.7, y * 1.9) - 0.5) * 0.035;
		const first = [];
		for (let i = 0; i < n; i += 18) {
			const p = rows[Math.min(n, i + 9)];
			const c = chunks.at(p.x, p.z, make);
			const base = c.pos.length / 3;
			const span = Math.min(18, n - i);
			const ROWS = 15;
			for (let k = 0; k <= span; k++) {
				const q = rows[i + k];
				// The open side is on the left of the walking direction.
				const nx = q.tz;
				const nz = -q.tx;
				const top = ceilingAt(q.x + nx * 0.2, q.z + nz * 0.2) + 0.45;
				for (let r = 0; r <= ROWS; r++) {
					const y = -0.1 + ((top + 0.1) * r) / ROWS;
					// A foot that flares out and melts into the floor, a surface that wanders, and stones that really stand out.
					const foot = 0.17 * Math.max(0, 1 - y / 0.42) ** 2;
					const fade = Math.max(0, (q.s - closed + 2) / 2);
					const wander = fade > 0 ? wanderAt(q.s, y) * (1 - fade) + wanderAt(q.s - closed, y) * fade : wanderAt(q.s, y);
					const relief = (heightOf(q.s * 0.75, y * 0.75) - 0.5) * 0.09;
					let push = foot + wander + relief;
					// The last row is the first row again: exactly, so the rasteriser finds no gap between them.
					if (i + k === 0) first[r] = push;
					else if (i + k === n) push = first[r];
					c.pos.push(q.x + ox + nx * push, y, q.z + oz + nz * push);
					c.nor.push(nx + q.tx * 0, 0, nz);
					c.s.push(q.s);
					c.tan.push(q.tx, q.tz);
				}
			}
			const stride = ROWS + 1;
			for (let k = 0; k < span; k++) for (let r = 0; r < ROWS; r++) {
				const A = base + k * stride + r;
				const B = A + stride;
				c.idx.push(A, A + 1, B, B, A + 1, B + 1);
			}
		}
	}
	const out = [];
	for (const c of chunks.map.values()) {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
		g.setAttribute('normal', new THREE.Float32BufferAttribute(c.nor, 3));
		g.setAttribute('aS', new THREE.Float32BufferAttribute(c.s, 1));
		g.setAttribute('aTan', new THREE.Float32BufferAttribute(c.tan, 2));
		g.setIndex(c.idx);
		// Normals from the real shape, keeping the relief lit, then the sweep's direction where a seam would show.
		g.computeVertexNormals();
		out.push(g);
	}
	return out;
}

/** A surface over the cells `want` accepts, with height `y(x, z)` in grid coordinates. Faces up or down. */
function gridSurface(d, want, y, down, res) {
	const chunks = new Chunks();
	const ox = -d.W / 2;
	const oz = -d.H / 2;
	const make = () => ({ pos: [], idx: [], index: new Map() });
	const vert = (c, ix, iz) => {
		const key = iz * 100000 + ix;
		let v = c.index.get(key);
		if (v === undefined) {
			v = c.pos.length / 3;
			const x = ix / res;
			const z = iz / res;
			c.pos.push(x + ox, y(x, z), z + oz);
			c.index.set(key, v);
		}
		return v;
	};
	for (let cy = 0; cy < d.H; cy++) for (let cx = 0; cx < d.W; cx++) {
		if (!want(cx, cy)) continue;
		const c = chunks.at(cx, cy, make);
		for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
			const a = vert(c, cx * res + i, cy * res + j);
			const b = vert(c, cx * res + i + 1, cy * res + j);
			const e = vert(c, cx * res + i, cy * res + j + 1);
			const g = vert(c, cx * res + i + 1, cy * res + j + 1);
			if (down) c.idx.push(a, b, e, b, g, e);
			else c.idx.push(a, e, b, b, e, g);
		}
	}
	const out = [];
	for (const c of chunks.map.values()) {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
		g.setIndex(c.idx);
		g.computeVertexNormals();
		out.push(g);
	}
	return out;
}

/** The earth under the stones. The middle of a room stays close to level, as things stand on it; it banks up against the walls and buries the paving there. */
export function floorGeometry(d, field, heightOf) {
	const noise = makeNoise(23);
	const edgeAt = (x, z) => Math.max(0, 1 - Math.max(0, fieldAt(field, x, z, 'soft') - 0.5) / 0.5) ** 2;
	const y = (x, z) => {
		const edge = edgeAt(x, z);
		const roll = (noise(x * 0.7, z * 0.7) - 0.5) * 0.012 + (noise(x * 2.3, z * 2.3) - 0.5) * 0.005;
		// Earth banks up in a room's corners, but a passage's stairs run from wall to wall.
		let bank = 0.25;
		const ix = Math.floor(x);
		const iz = Math.floor(z);
		for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
			const c = (iz + oz) * d.W + ix + ox;
			if (c >= 0 && c < d.roomId.length && d.roomId[c] >= 0) bank = 1;
		}
		return bedAt(d, x, z) + roll + bank * edge * edge * (0.05 + noise(x * 1.4, z * 1.4) * 0.05);
	};
	return gridSurface(d, (cx, cy) => {
		const g = d.grid[cy * d.W + cx];
		if (g === 1 || g === 3) return true;
		// Under the wall's foot too, so nothing shows at the join.
		for (let oy = -1; oy <= 1; oy++) for (let ax = -1; ax <= 1; ax++) {
			const c = (cy + oy) * d.W + cx + ax;
			if (c >= 0 && c < d.grid.length && (d.grid[c] === 1 || d.grid[c] === 3)) return true;
		}
		return false;
	}, y, false, 5);
}

/** Corridors and doorways: rounded tunnels that curve down into their walls. Writes their real height into `heights`. */
export function tunnelGeometry(d, field, heights) {
	const dist = chamfer(field);
	const SPRING = 0.92;
	const RISE = 1;
	const noise = makeNoise(31);
	const y = (x, z) => {
		const t = Math.min(1, distAt(dist, field, x, z) / 1.05);
		return rampAt(d, x, z) + SPRING + RISE * Math.sqrt(Math.max(0, 1 - (1 - t) ** 2)) + (noise(x * 1.2, z * 1.2) - 0.5) * 0.05;
	};
	const want = (cx, cy) => {
		const c = cy * d.W + cx;
		if (d.grid[c] !== 1 && d.grid[c] !== 3) {
			// A rim into the rock, so the wall always has a ceiling to meet.
			for (let oy = -1; oy <= 1; oy++) for (let ax = -1; ax <= 1; ax++) {
				const n = (cy + oy) * d.W + cx + ax;
				if (n >= 0 && n < d.grid.length && (d.grid[n] === 1 || d.grid[n] === 3) && d.roomId[n] < 0) return true;
			}
			return false;
		}
		return d.roomId[c] < 0;
	};
	for (let cy = 0; cy < d.H; cy++) for (let cx = 0; cx < d.W; cx++) {
		const c = cy * d.W + cx;
		if ((d.grid[c] === 1 || d.grid[c] === 3) && d.roomId[c] < 0) heights[c] = y(cx + 0.5, cy + 0.5);
	}
	return gridSurface(d, want, y, true, 4);
}

function chamfer(field) {
	const { w, h } = field;
	const f = new Float32Array(w * h);
	for (let i = 0; i < f.length; i++) f[i] = field.f[i] >= 0.5 ? 1e6 : 0;
	const pass = (x, y, dx, dy, c) => {
		const nx = x + dx;
		const ny = y + dy;
		if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
		const v = f[ny * w + nx] + c;
		if (v < f[y * w + x]) f[y * w + x] = v;
	};
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		pass(x, y, -1, 0, 1);
		pass(x, y, 0, -1, 1);
		pass(x, y, -1, -1, Math.SQRT2);
		pass(x, y, 1, -1, Math.SQRT2);
	}
	for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
		pass(x, y, 1, 0, 1);
		pass(x, y, 0, 1, 1);
		pass(x, y, 1, 1, Math.SQRT2);
		pass(x, y, -1, 1, Math.SQRT2);
	}
	for (let i = 0; i < f.length; i++) f[i] /= RES;
	return f;
}

function distAt(dist, field, cx, cy) {
	return fieldAt({ ...field, d: dist }, cx, cy, 'd');
}

export function buildField(d) {
	return openField(d);
}
