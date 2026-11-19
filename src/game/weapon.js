// The held longsword and the spell hand, in their own little scene drawn over the level (view.overlay).
import * as THREE from 'three';

function scratchTexture() {
	const c = document.createElement('canvas');
	c.width = c.height = 256;
	const g = c.getContext('2d');
	g.fillStyle = '#6a6a6a';
	g.fillRect(0, 0, 256, 256);
	for (let i = 0; i < 900; i++) {
		const v = 80 + Math.random() * 120;
		g.strokeStyle = `rgba(${v},${v},${v},${Math.random() * 0.5})`;
		g.lineWidth = Math.random() * 1.2;
		g.beginPath();
		const x = Math.random() * 256;
		const y = Math.random() * 256;
		g.moveTo(x, y);
		g.lineTo(x + (Math.random() - 0.5) * 30, y + (Math.random() - 0.5) * 120);
		g.stroke();
	}
	for (let i = 0; i < 60; i++) {
		g.fillStyle = `rgba(40,30,25,${Math.random() * 0.5})`;
		g.beginPath();
		g.arc(Math.random() * 256, Math.random() * 256, Math.random() * 6, 0, 7);
		g.fill();
	}
	const t = new THREE.CanvasTexture(c);
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	return t;
}

function makeEnv(renderer) {
	const s = new THREE.Scene();
	s.background = new THREE.Color(0x050403);
	const panel = (color, x, y, z, w, h) => {
		const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
		m.position.set(x, y, z);
		m.lookAt(0, 0, 0);
		s.add(m);
	};
	panel(new THREE.Color(3, 1.6, 0.7), 4, 3, 2, 3, 2);
	panel(new THREE.Color(1.2, 0.7, 0.35), -5, 1, -3, 4, 3);
	panel(new THREE.Color(0.25, 0.32, 0.45), 0, 6, -2, 8, 3);
	panel(new THREE.Color(0.08, 0.07, 0.06), 0, -5, 0, 12, 12);
	const pm = new THREE.PMREMGenerator(renderer);
	const rt = pm.fromScene(s, 0.04);
	pm.dispose();
	return rt.texture;
}

function buildSword(env) {
	const g = new THREE.Group();
	const scratch = scratchTexture();
	const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 1, roughness: 0.3, roughnessMap: scratch, envMap: env, envMapIntensity: 1.1 });
	const fuller = new THREE.MeshStandardMaterial({ color: 0x8c9098, metalness: 1, roughness: 0.42, envMap: env });
	const iron = new THREE.MeshStandardMaterial({ color: 0x3a3632, metalness: 0.9, roughness: 0.45, envMap: env, roughnessMap: scratch });
	const brass = new THREE.MeshStandardMaterial({ color: 0xa9803e, metalness: 1, roughness: 0.32, envMap: env });
	const leather = new THREE.MeshStandardMaterial({ color: 0x2b1a12, roughness: 0.85, metalness: 0 });

	// Blade: a diamond section that narrows to a point.
	const L = 0.86;
	const shape = [];
	const N = 14;
	for (let i = 0; i <= N; i++) {
		const t = i / N;
		const w = t < 0.86 ? 0.026 - t * 0.008 : (0.019 * (1 - t)) / 0.14;
		shape.push([t * L, w]);
	}
	const pos = [];
	const idx = [];
	const th = 0.0065;
	for (const [y, w] of shape) pos.push(-w, y, 0, 0, y, th, w, y, 0, 0, y, -th);
	for (let i = 0; i < N; i++) {
		const a = i * 4;
		const b = a + 4;
		for (let k = 0; k < 4; k++) {
			const k1 = (k + 1) % 4;
			idx.push(a + k, b + k, b + k1, a + k, b + k1, a + k1);
		}
	}
	const bg = new THREE.BufferGeometry();
	bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	bg.setIndex(idx);
	bg.computeVertexNormals();
	const uv = [];
	for (const [y] of shape) uv.push(0, y * 2, 0.5, y * 2, 1, y * 2, 0.5, y * 2);
	bg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	const blade = new THREE.Mesh(bg, steel);
	blade.position.y = 0.11;
	g.add(blade);
	const fl = new THREE.Mesh(new THREE.BoxGeometry(0.008, L * 0.6, 0.0135), fuller);
	fl.position.y = 0.11 + L * 0.33;
	g.add(fl);
	// Crossguard with flared ends.
	const guard = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.022, 0.03), iron);
	guard.position.y = 0.1;
	g.add(guard);
	for (const s of [-1, 1]) {
		const end = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), brass);
		end.position.set(s * 0.1, 0.105, 0);
		g.add(end);
	}
	const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.17, 10), leather);
	grip.position.y = 0.0;
	g.add(grip);
	for (let i = 0; i < 5; i++) {
		const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.0175, 0.003, 6, 14), leather);
		wrap.rotation.x = Math.PI / 2;
		wrap.position.y = -0.065 + i * 0.032;
		g.add(wrap);
	}
	const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), brass);
	pommel.scale.y = 0.8;
	pommel.position.y = -0.1;
	g.add(pommel);
	return g;
}

// Poses in camera space: blade along the sword's +Y. Euler order YXZ: yaw sweeps, pitch tips the blade forward, roll turns the edge.
const P = (x, y, z, ry, rx, rz) => ({ p: new THREE.Vector3(x, y, z), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')) });
const REST = P(0.26, -0.3, -0.5, 0.2, -0.45, -0.35);
const SWINGS = [
	// right to left
	{ wind: P(0.42, -0.12, -0.36, -1.15, -1.3, -1.45), end: P(-0.38, -0.3, -0.44, 1.25, -1.45, -1.6) },
	// left to right, backhand
	{ wind: P(-0.3, -0.08, -0.36, 1.1, -1.2, 1.5), end: P(0.42, -0.32, -0.42, -1.25, -1.45, 1.6) },
	// overhead
	{ wind: P(0.14, 0.08, -0.28, 0.05, 0.35, -0.1), end: P(0.04, -0.46, -0.5, 0, -2.05, -0.05) },
];
const STAB = { wind: P(0.2, -0.22, -0.2, 0.05, -1.5, -1.57), end: P(0.08, -0.16, -0.8, 0, -1.58, -1.57) };

const ease = (t) => 1 - (1 - t) ** 3;
const easeIn = (t) => t * t;

export function createWeapon(renderer) {
	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
	const env = makeEnv(renderer);
	const hemi = new THREE.HemisphereLight(0x7a8aa0, 0x1a1410, 0.5);
	scene.add(hemi);
	const key = new THREE.PointLight(0xffb070, 3, 4, 2);
	key.position.set(0.3, 0.4, 0.1);
	scene.add(key);
	const fireKey = new THREE.PointLight(0xff7030, 0, 3, 2);
	fireKey.position.set(-0.3, -0.25, -0.5);
	scene.add(fireKey);

	const holder = new THREE.Group();
	scene.add(holder);
	const sword = buildSword(env);
	sword.scale.setScalar(0.95);
	holder.add(sword);

	// Trail ribbon behind the edge while a swing is live.
	const TN = 14;
	const tPos = new Float32Array(TN * 2 * 3);
	const tAlpha = new Float32Array(TN * 2);
	const tGeo = new THREE.BufferGeometry();
	tGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage));
	tGeo.setAttribute('aA', new THREE.BufferAttribute(tAlpha, 1).setUsage(THREE.DynamicDrawUsage));
	const ti = [];
	for (let i = 0; i < TN - 1; i++) ti.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
	tGeo.setIndex(ti);
	const trailMat = new THREE.ShaderMaterial({
		vertexShader: 'attribute float aA; varying float vA; void main(){ vA=aA; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
		fragmentShader: 'uniform vec3 uC; varying float vA; void main(){ gl_FragColor=vec4(uC*vA, vA); }',
		uniforms: { uC: { value: new THREE.Color(1.6, 1.25, 0.9) } },
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		side: THREE.DoubleSide,
	});
	const trail = new THREE.Mesh(tGeo, trailMat);
	trail.frustumCulled = false;
	scene.add(trail);
	const samples = [];

	// The spell hand: an ember that sits low on the left and flares when casting.
	const orbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.7, 0.5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
	const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.035, 2), orbMat);
	const halo = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.ShaderMaterial({
		vertexShader: 'varying vec2 vU; void main(){ vU=uv*2.0-1.0; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} ',
		fragmentShader: 'uniform float uK, uT; varying vec2 vU; void main(){ float r=length(vU); float a=pow(max(0.0,1.0-r),2.2)*uK*(0.85+0.15*sin(uT*23.0)); gl_FragColor=vec4(vec3(2.2,0.9,0.25)*a, a); }',
		uniforms: { uK: { value: 0.6 }, uT: { value: 0 } },
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
	}));
	const hand = new THREE.Group();
	hand.add(orb, halo);
	hand.position.set(-0.3, -0.3, -0.55);
	scene.add(hand);

	let swing = null;
	let queued = false;
	let combo = 0;
	let cast = 0;
	let bobT = 0;
	let draw = 1;
	const cur = { p: REST.p.clone(), q: REST.q.clone() };
	const tmpQ = new THREE.Quaternion();
	const tmpP = new THREE.Vector3();
	const base = new THREE.Vector3();
	const tip = new THREE.Vector3();

	const SW = { wind: 0.09, strike: 0.15, recover: 0.24 };

	return {
		scene,
		camera,
		env,
		get swinging() {
			return !!swing;
		},
		// Starts a swing, or queues the next one if this one is past its strike. Returns the swing's index or -1.
		attack(speed = 1) {
			if (swing) {
				if (swing.t > SW.wind) queued = true;
				return -1;
			}
			const kind = combo % 3;
			combo++;
			swing = { kind, t: 0, speed, from: { p: cur.p.clone(), q: cur.q.clone() }, hitDone: false, def: SWINGS[kind] };
			samples.length = 0;
			return kind;
		},
		stab() {
			swing = { kind: 3, t: 0, speed: 1, from: { p: cur.p.clone(), q: cur.q.clone() }, hitDone: false, def: STAB };
			samples.length = 0;
		},
		cast() {
			cast = 1;
		},
		// Called each frame; returns 'strike' on the frame the edge passes through the middle of the view.
		update(dt, { aspect, moving, speed, time, mana }) {
			camera.aspect = aspect;
			// Keep at least ~84 degrees across, so a narrow window still shows the blade.
			camera.fov = Math.max(62, (2 * Math.atan(Math.tan((42 * Math.PI) / 180) / aspect) * 180) / Math.PI);
			camera.updateProjectionMatrix();
			let event = null;
			draw = Math.max(0, draw - dt * 2.5);
			bobT += dt * (moving ? 6 + speed : 1.4);
			const bob = moving ? 0.012 : 0.004;
			if (swing) {
				swing.t += dt * swing.speed;
				const { wind, strike, recover } = SW;
				const t = swing.t;
				if (t < wind) {
					const k = ease(t / wind);
					cur.p.lerpVectors(swing.from.p, swing.def.wind.p, k);
					cur.q.slerpQuaternions(swing.from.q, swing.def.wind.q, k);
				} else if (t < wind + strike) {
					const k = easeIn((t - wind) / strike) * 0.35 + ((t - wind) / strike) * 0.65;
					cur.p.lerpVectors(swing.def.wind.p, swing.def.end.p, k);
					cur.q.slerpQuaternions(swing.def.wind.q, swing.def.end.q, k);
					if (!swing.hitDone && k > 0.42) {
						swing.hitDone = true;
						event = 'strike';
					}
				} else if (t < wind + strike + recover) {
					if (queued) {
						queued = false;
						const kind = combo % 3;
						combo++;
						swing = { kind, t: 0, speed: swing.speed, from: { p: cur.p.clone(), q: cur.q.clone() }, hitDone: false, def: SWINGS[kind] };
						samples.length = 0;
					} else {
						const k = ease((t - wind - strike) / recover);
						cur.p.lerpVectors(swing.def.end.p, REST.p, k);
						cur.q.slerpQuaternions(swing.def.end.q, REST.q, k);
					}
				} else {
					swing = null;
					combo = 0;
				}
			} else {
				cur.p.lerp(REST.p, 1 - Math.exp(-dt * 10));
				cur.q.slerp(REST.q, 1 - Math.exp(-dt * 10));
			}
			holder.position.copy(cur.p);
			holder.position.x += Math.sin(bobT) * bob;
			holder.position.y += Math.abs(Math.cos(bobT)) * bob - draw * 0.5;
			holder.quaternion.copy(cur.q);
			// Trail from the edge's two ends, while the blade is moving fast.
			const live = swing && swing.t > SW.wind * 0.6 && swing.t < SW.wind + SW.strike + 0.06;
			holder.updateMatrixWorld();
			base.set(0, 0.32, 0).applyMatrix4(sword.matrixWorld);
			tip.set(0, 0.98, 0).applyMatrix4(sword.matrixWorld);
			if (live) samples.unshift([base.clone(), tip.clone(), 1]);
			for (const s of samples) s[2] -= dt * 7;
			while (samples.length > TN || (samples.length && samples[samples.length - 1][2] <= 0)) samples.pop();
			for (let i = 0; i < TN; i++) {
				const s = samples[Math.min(i, samples.length - 1)];
				const a = s ? Math.max(0, s[2]) * (1 - i / TN) * 0.55 : 0;
				const b = s ? s[0] : base;
				const tp = s ? s[1] : tip;
				tPos.set([b.x, b.y, b.z, tp.x, tp.y, tp.z], i * 6);
				tAlpha[i * 2] = 0;
				tAlpha[i * 2 + 1] = a;
			}
			tGeo.attributes.position.needsUpdate = true;
			tGeo.attributes.aA.needsUpdate = true;
			// Spell hand.
			cast = Math.max(0, cast - dt * 3);
			const ready = mana;
			halo.material.uniforms.uT.value = time;
			halo.material.uniforms.uK.value = 0.15 + ready * 0.3 + cast * 2.5;
			orb.scale.setScalar(0.35 + ready * 0.3 + cast * 1.2 + Math.sin(time * 17) * 0.04);
			hand.position.set(-0.34 + cast * 0.08, -0.34 + Math.abs(Math.cos(bobT)) * bob + cast * 0.1 - draw * 0.5, -0.55 - cast * 0.15);
			fireKey.intensity = 0.4 + ready * 0.6 + cast * 6;
			fireKey.position.copy(hand.position);
			tmpP.set(0, 0, 0);
			tmpQ.identity();
			return event;
		},
		setLight(k) {
			key.intensity = 2.2 * k;
		},
	};
}
