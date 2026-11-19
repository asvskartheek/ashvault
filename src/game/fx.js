// Particles, pooled lights, fireballs, shockwave rings and floating numbers. Metres, world space.
import * as THREE from 'three';

const VERT = `
attribute float aSize; attribute vec4 aCol;
varying vec4 vCol;
uniform float uPx;
void main(){
	vCol = aCol;
	vec4 mv = modelViewMatrix * vec4(position,1.0);
	gl_Position = projectionMatrix * mv;
	gl_PointSize = aSize * uPx / max(0.05, -mv.z);
	vCol *= smoothstep(0.25, 0.9, -mv.z);
}`;
const FRAG = `
varying vec4 vCol;
void main(){
	vec2 p = gl_PointCoord*2.0-1.0;
	float r = dot(p,p);
	if(r>1.0) discard;
	float a = (1.0-r); a*=a;
	gl_FragColor = vec4(vCol.rgb*a, vCol.a*a);
}`;

function makePool(n, blending) {
	const geo = new THREE.BufferGeometry();
	const pos = new Float32Array(n * 3);
	const col = new Float32Array(n * 4);
	const size = new Float32Array(n);
	geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
	geo.setAttribute('aCol', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
	geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
	const mat = new THREE.ShaderMaterial({
		vertexShader: VERT,
		fragmentShader: FRAG,
		uniforms: { uPx: { value: 600 } },
		transparent: true,
		depthWrite: false,
		blending,
	});
	const pts = new THREE.Points(geo, mat);
	pts.frustumCulled = false;
	pts.renderOrder = 10;
	const P = [];
	for (let i = 0; i < n; i++) P.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 1, g: 1, b: 1, a: 1, s: 0.1, s1: 0.1, grav: 0, drag: 0 });
	let head = 0;
	return {
		pts,
		mat,
		spawn(o) {
			const p = P[head];
			head = (head + 1) % n;
			Object.assign(p, { grav: 0, drag: 0, a: 1, s1: o.s ?? 0.1 }, o);
			p.life = p.max;
			return p;
		},
		update(dt) {
			let k = 0;
			for (const p of P) {
				if (p.life <= 0) continue;
				p.life -= dt;
				if (p.life <= 0) continue;
				const d = Math.exp(-p.drag * dt);
				p.vx *= d;
				p.vy = p.vy * d - p.grav * dt;
				p.vz *= d;
				p.x += p.vx * dt;
				p.y += p.vy * dt;
				p.z += p.vz * dt;
				if (p.floor !== undefined && p.y < p.floor) {
					p.y = p.floor;
					p.vy *= -0.3;
					p.vx *= 0.6;
					p.vz *= 0.6;
				}
				const t = p.life / p.max;
				pos[k * 3] = p.x;
				pos[k * 3 + 1] = p.y;
				pos[k * 3 + 2] = p.z;
				const fade = Math.min(1, t * 3);
				col[k * 4] = p.r * fade;
				col[k * 4 + 1] = p.g * fade;
				col[k * 4 + 2] = p.b * fade;
				col[k * 4 + 3] = p.a * fade;
				size[k] = p.s1 + (p.s - p.s1) * t;
				k++;
			}
			geo.setDrawRange(0, k);
			geo.attributes.position.needsUpdate = true;
			geo.attributes.aCol.needsUpdate = true;
			geo.attributes.aSize.needsUpdate = true;
		},
	};
}

export function createFx(scene, { budget = 1 } = {}) {
	const add = makePool(Math.round(2400 * budget), THREE.AdditiveBlending);
	const dust = makePool(Math.round(900 * budget), THREE.NormalBlending);
	scene.add(add.pts, dust.pts);
	const rnd = (a, b) => a + Math.random() * (b - a);
	const sph = (s) => {
		const u = Math.random() * 2 - 1;
		const t = Math.random() * Math.PI * 2;
		const r = Math.sqrt(1 - u * u);
		return [Math.cos(t) * r * s, u * s, Math.sin(t) * r * s];
	};

	// Lights made once, before anything compiles, so their count never changes and nothing recompiles mid-fight.
	const lights = [];
	for (let i = 0; i < 4; i++) {
		const l = new THREE.PointLight(0xff8840, 0, 9, 2);
		scene.add(l);
		lights.push({ l, life: 0, max: 1, peak: 0, follow: null });
	}
	function flashLight(x, y, z, color, peak, dur, follow = null) {
		const s = lights.reduce((a, b) => (a.life / a.max < b.life / b.max ? a : b));
		s.l.position.set(x, y, z);
		s.l.color.set(color);
		s.peak = peak;
		s.life = s.max = dur;
		s.follow = follow;
		return s;
	}

	// Shockwave rings: a flat additive torus that grows.
	const ringGeo = new THREE.RingGeometry(0.85, 1, 64);
	ringGeo.rotateX(-Math.PI / 2);
	const rings = [];
	for (let i = 0; i < 4; i++) {
		const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
		m.visible = false;
		m.renderOrder = 11;
		scene.add(m);
		rings.push({ m, life: 0, max: 1, r0: 0, r1: 1 });
	}

	// Fireballs: a hot core plus a stream of flame particles and a light that rides with it.
	const coreGeo = new THREE.IcosahedronGeometry(0.16, 2);
	const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 3.2, 1.2) });
	const balls = [];

	const api = {
		lights,
		sparks(x, y, z, n = 18, color = [3, 1.8, 0.7], speed = 6) {
			for (let i = 0; i < n * budget; i++) {
				const [vx, vy, vz] = sph(rnd(0.3, 1) * speed);
				add.spawn({ x, y, z, vx, vy: vy + 1.5, vz, r: color[0], g: color[1], b: color[2], a: 1, s: rnd(0.025, 0.05), s1: 0.005, max: rnd(0.2, 0.5), grav: 9, drag: 2 });
			}
		},
		bones(x, y, z, n = 20, floor = 0) {
			for (let i = 0; i < n * budget; i++) {
				const [vx, vy, vz] = sph(rnd(1, 4));
				dust.spawn({ x, y, z, vx, vy: Math.abs(vy) + 1.5, vz, r: 0.42, g: 0.39, b: 0.33, a: 1, s: rnd(0.04, 0.09), s1: 0.03, max: rnd(0.8, 1.6), grav: 9.8, drag: 0.6, floor: floor + 0.03 });
			}
			for (let i = 0; i < n * 0.8 * budget; i++) {
				const [vx, vy, vz] = sph(rnd(0.3, 1.2));
				dust.spawn({ x: x + vx * 0.3, y: y + vy * 0.3, z: z + vz * 0.3, vx, vy: vy * 0.3 + 0.3, vz, r: 0.16, g: 0.15, b: 0.13, a: 0.22, s: rnd(0.1, 0.2), s1: 0.35, max: rnd(0.9, 1.6), drag: 1.5 });
			}
		},
		soul(x, y, z, color = [0.6, 1.4, 1.2]) {
			for (let i = 0; i < 26 * budget; i++) {
				const [vx, , vz] = sph(rnd(0.2, 0.8));
				add.spawn({ x: x + vx * 0.4, y: y + rnd(0, 1.4), z: z + vz * 0.4, vx, vy: rnd(0.8, 2.2), vz, r: color[0], g: color[1], b: color[2], s: rnd(0.04, 0.09), s1: 0.01, max: rnd(0.7, 1.4), drag: 1 });
			}
		},
		riseDust(x, y, z) {
			for (let i = 0; i < 30 * budget; i++) {
				const a = Math.random() * Math.PI * 2;
				const r = rnd(0.1, 0.7);
				dust.spawn({ x: x + Math.cos(a) * r, y: y + 0.05, z: z + Math.sin(a) * r, vx: Math.cos(a) * rnd(0.3, 1.2), vy: rnd(0.3, 1.4), vz: Math.sin(a) * rnd(0.3, 1.2), r: 0.2, g: 0.19, b: 0.16, a: 0.3, s: rnd(0.1, 0.22), s1: 0.4, max: rnd(1, 2), drag: 1.8 });
			}
			for (let i = 0; i < 10 * budget; i++) add.spawn({ x: x + rnd(-0.4, 0.4), y: y + 0.05, z: z + rnd(-0.4, 0.4), vx: 0, vy: rnd(0.5, 1.5), vz: 0, r: 0.4, g: 1.2, b: 1.0, s: 0.06, s1: 0.01, max: rnd(0.6, 1.1), drag: 0.5 });
		},
		wispTrail(x, y, z, k = 1) {
			for (let i = 0; i < 3 * k * budget; i++) add.spawn({ x: x + rnd(-0.08, 0.08), y: y + rnd(-0.08, 0.08), z: z + rnd(-0.08, 0.08), vx: rnd(-0.2, 0.2), vy: rnd(-0.6, -0.1), vz: rnd(-0.2, 0.2), r: 0.3, g: 1.1 * k, b: 1.5 * k, s: rnd(0.06, 0.14), s1: 0.01, max: rnd(0.3, 0.7), drag: 1.5 });
		},
		blood(x, y, z, n = 14, floor = 0) {
			for (let i = 0; i < n * budget; i++) {
				const [vx, vy, vz] = sph(rnd(1, 3.5));
				dust.spawn({ x, y, z, vx, vy: vy + 1, vz, r: 0.18, g: 0.02, b: 0.015, a: 0.9, s: rnd(0.04, 0.08), s1: 0.02, max: rnd(0.4, 0.8), grav: 9.8, drag: 0.8, floor });
			}
		},
		ring(x, y, z, r1, color = 0xffc070, dur = 0.45) {
			const s = rings.reduce((a, b) => (a.life < b.life ? a : b));
			s.m.position.set(x, y + 0.06, z);
			s.m.material.color.set(color);
			s.life = s.max = dur;
			s.r1 = r1;
			s.m.visible = true;
		},
		explosion(x, y, z, scale = 1) {
			flashLight(x, y + 0.3, z, 0xff7a30, 28 * scale, 0.55);
			for (let i = 0; i < 90 * scale * budget; i++) {
				const [vx, vy, vz] = sph(rnd(0.5, 1) * 7 * scale);
				const hot = Math.random();
				add.spawn({ x, y, z, vx, vy: vy + 1, vz, r: 4, g: 1.4 + hot * 1.5, b: 0.35, s: rnd(0.12, 0.3) * scale, s1: 0.02, max: rnd(0.25, 0.6), drag: 4.5 });
			}
			for (let i = 0; i < 30 * scale * budget; i++) {
				const [vx, vy, vz] = sph(rnd(0.5, 1) * 2.5);
				dust.spawn({ x, y, z, vx, vy: vy + 1.2, vz, r: 0.08, g: 0.07, b: 0.06, a: 0.5, s: rnd(0.2, 0.4) * scale, s1: 0.7 * scale, max: rnd(1, 1.8), drag: 2 });
			}
			api.sparks(x, y, z, 30 * scale, [4, 2, 0.6], 9);
			api.ring(x, y - 0.3, z, 3.2 * scale, 0xff8a40, 0.4);
		},
		fireball(x, y, z, dx, dy, dz, speed, onHit) {
			const m = new THREE.Mesh(coreGeo, coreMat);
			m.position.set(x, y, z);
			m.renderOrder = 9;
			scene.add(m);
			const light = flashLight(x, y, z, 0xff8a3a, 9, 3, m);
			balls.push({ m, light, vx: dx * speed, vy: dy * speed, vz: dz * speed, life: 2.5, onHit });
		},
		bolt(x, y, z, dx, dy, dz, speed, onHit) {
			const m = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.8, 3, 2.6) }));
			m.scale.setScalar(0.7);
			m.position.set(x, y, z);
			scene.add(m);
			const b = { m, light: null, vx: dx * speed, vy: dy * speed, vz: dz * speed, life: 3, onHit, kind: 'bolt' };
			balls.push(b);
			api._lastBall = b;
		},
		update(dt, pxScale, test) {
			add.mat.uniforms.uPx.value = pxScale;
			dust.mat.uniforms.uPx.value = pxScale;
			for (let i = balls.length - 1; i >= 0; i--) {
				const b = balls[i];
				b.life -= dt;
				const n = Math.max(1, Math.ceil((Math.hypot(b.vx, b.vy, b.vz) * dt) / 0.2));
				let hit = b.life <= 0;
				for (let s = 0; s < n && !hit; s++) {
					b.m.position.x += (b.vx * dt) / n;
					b.m.position.y += (b.vy * dt) / n;
					b.m.position.z += (b.vz * dt) / n;
					hit = test(b.m.position, b);
				}
				const p = b.m.position;
				if (b.kind === 'bolt') {
					for (let k = 0; k < 3 * budget; k++) add.spawn({ x: p.x + rnd(-0.05, 0.05), y: p.y + rnd(-0.05, 0.05), z: p.z + rnd(-0.05, 0.05), vx: rnd(-0.3, 0.3), vy: rnd(-0.3, 0.3), vz: rnd(-0.3, 0.3), r: 0.5, g: 2.2, b: 1.9, s: rnd(0.08, 0.14), s1: 0.01, max: rnd(0.15, 0.35) });
				} else {
					for (let k = 0; k < 7 * budget; k++) add.spawn({ x: p.x + rnd(-0.08, 0.08), y: p.y + rnd(-0.08, 0.08), z: p.z + rnd(-0.08, 0.08), vx: rnd(-0.6, 0.6), vy: rnd(0, 1.2), vz: rnd(-0.6, 0.6), r: 4, g: rnd(1.2, 2.4), b: 0.4, s: rnd(0.12, 0.26), s1: 0.02, max: rnd(0.15, 0.4), drag: 2 });
					if (Math.random() < 0.5) dust.spawn({ x: p.x, y: p.y, z: p.z, vx: 0, vy: 0.6, vz: 0, r: 0.06, g: 0.05, b: 0.05, a: 0.3, s: 0.1, s1: 0.3, max: 0.8, drag: 1 });
				}
				if (hit) {
					scene.remove(b.m);
					if (b.light) b.light.life = Math.min(b.light.life, 0.05);
					b.onHit?.(p.clone());
					balls.splice(i, 1);
				}
			}
			for (const s of lights) {
				if (s.life <= 0) {
					s.l.intensity = 0;
					continue;
				}
				s.life -= dt;
				if (s.follow) s.l.position.copy(s.follow.position);
				const t = Math.max(0, s.life / s.max);
				s.l.intensity = s.follow ? s.peak * (0.85 + Math.random() * 0.3) : s.peak * t * t;
			}
			for (const r of rings) {
				if (r.life <= 0) {
					r.m.visible = false;
					continue;
				}
				r.life -= dt;
				const t = 1 - r.life / r.max;
				r.m.scale.setScalar(0.2 + r.r1 * (1 - (1 - t) ** 3));
				r.m.material.opacity = (1 - t) * 1.5;
			}
			add.update(dt);
			dust.update(dt);
		},
		flashLight,
	};
	return api;
}

// Numbers that float up from a hit, drawn in the DOM.
export function createNumbers(root) {
	const pool = [];
	for (let i = 0; i < 28; i++) {
		const el = document.createElement('div');
		el.className = 'num';
		root.appendChild(el);
		pool.push({ el, life: 0, x: 0, y: 0, z: 0, vy: 0 });
	}
	let head = 0;
	const v = new THREE.Vector3();
	return {
		show(x, y, z, text, cls = '') {
			const n = pool[head];
			head = (head + 1) % pool.length;
			n.el.textContent = text;
			n.el.className = `num ${cls}`;
			n.x = x + (Math.random() - 0.5) * 0.4;
			n.y = y;
			n.z = z + (Math.random() - 0.5) * 0.4;
			n.vy = 1.4;
			n.life = cls.includes('crit') ? 1.3 : 0.9;
			n.max = n.life;
		},
		update(dt, camera, w, h) {
			for (const n of pool) {
				if (n.life <= 0) {
					if (n.el.style.opacity !== '0') n.el.style.opacity = '0';
					continue;
				}
				n.life -= dt;
				n.y += n.vy * dt;
				n.vy *= Math.exp(-dt * 2.5);
				v.set(n.x, n.y, n.z).project(camera);
				if (v.z > 1) {
					n.el.style.opacity = '0';
					continue;
				}
				const t = n.life / n.max;
				const pop = t > 0.85 ? 1 + (t - 0.85) * 4 : 1;
				n.el.style.opacity = String(Math.min(1, t * 3));
				n.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%,-50%) scale(${pop})`;
			}
		},
	};
}
