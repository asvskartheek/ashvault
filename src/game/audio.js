// Sound: Patch toolbox samples (Kenney, CC0; music by Kevin MacLeod, CC BY 4.0) plus a few synthesised layers.
// ?mute starts silent and never loads the music. M toggles sound in play.
const SAMPLES = {
	slice: 'knifeSlice.ogg',
	slice2: 'knifeSlice2.ogg',
	chop: 'chop.ogg',
	punch: 'impactPunch_heavy_000.ogg',
	punch2: 'impactPunch_medium_000.ogg',
	clang: 'impactMetal_heavy_000.ogg',
	draw: 'drawKnife1.ogg',
	step: 'footstep00.ogg',
	door: 'doorOpen_1.ogg',
	coins: 'handleCoins.ogg',
	cloth: 'cloth1.ogg',
};

export function createAudio({ muted = false } = {}) {
	let ctx = null;
	let master = null;
	let sfx = null;
	let musicGain = null;
	let noise = null;
	const buffers = {};
	let musicEl = null;
	let on = !muted;
	let combat = 0;
	// The DM's music mood: the fight swell is multiplied by it, and the music runs through a filter it can close.
	const MOODS = {
		calm: { mul: 0.6, cutoff: 900 },
		dread: { mul: 0.75, cutoff: 520, drone: true },
		battle: { mul: 1, cutoff: 20000 },
		boss: { mul: 1.1, cutoff: 20000, drum: true },
		silence: { mul: 0, cutoff: 20000 },
	};
	let mood = { mul: 1, cutoff: 20000 };
	let moodMul = 1;
	let moodFilter = null;
	let droneGain = null;
	let droneOsc = [];
	let drumTimer = 0;
	let vm = 1; // volume multiplier for the cue being played

	function init() {
		if (ctx) return;
		ctx = new AudioContext();
		master = ctx.createGain();
		master.gain.value = on ? 0.9 : 0;
		const comp = ctx.createDynamicsCompressor();
		comp.threshold.value = -14;
		comp.ratio.value = 4;
		master.connect(comp).connect(ctx.destination);
		sfx = ctx.createGain();
		sfx.connect(master);
		musicGain = ctx.createGain();
		musicGain.gain.value = 0;
		musicGain.connect(master);
		moodFilter = ctx.createBiquadFilter();
		moodFilter.type = 'lowpass';
		moodFilter.frequency.value = 20000;
		moodFilter.connect(musicGain);
		const len = ctx.sampleRate;
		noise = ctx.createBuffer(1, len, ctx.sampleRate);
		const ch = noise.getChannelData(0);
		for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
		for (const [k, f] of Object.entries(SAMPLES)) {
			fetch(`./assets/sound/${f}`).then((r) => r.arrayBuffer()).then((a) => ctx.decodeAudioData(a)).then((b) => (buffers[k] = b)).catch(() => {});
		}
		if (!muted) startMusic();
		applyMood();
	}

	function startMusic() {
		if (musicEl || !ctx) return;
		musicEl = new Audio('./assets/sound/final_battle_of_the_dark_wizards.ogg');
		musicEl.loop = true;
		musicEl.crossOrigin = 'anonymous';
		ctx.createMediaElementSource(musicEl).connect(moodFilter);
		musicEl.play().catch(() => {});
	}

	function resume() {
		init();
		if (ctx.state === 'suspended') ctx.resume().catch(() => {});
		if (on && musicEl?.paused) musicEl.play().catch(() => {});
	}

	function play(name, { vol = 1, rate = 1, jitter = 0.08 } = {}) {
		if (!ctx || !on || !buffers[name]) return;
		const s = ctx.createBufferSource();
		s.buffer = buffers[name];
		s.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
		const g = ctx.createGain();
		g.gain.value = vol * vm;
		s.connect(g).connect(sfx);
		s.start();
	}

	// Filtered noise with an envelope: whooshes, fire, rumbles.
	function noiseHit({ dur = 0.25, f0 = 800, f1 = 3000, q = 1.2, vol = 0.4, type = 'bandpass', attack = 0.01 } = {}) {
		if (!ctx || !on) return;
		const t = ctx.currentTime;
		const s = ctx.createBufferSource();
		s.buffer = noise;
		s.loop = true;
		const f = ctx.createBiquadFilter();
		f.type = type;
		f.Q.value = q;
		f.frequency.setValueAtTime(f0, t);
		f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * vm), t + attack);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		s.connect(f).connect(g).connect(sfx);
		s.start(t, Math.random());
		s.stop(t + dur + 0.05);
	}

	function tone({ freq = 220, freq1 = freq, dur = 0.3, type = 'sine', vol = 0.2, delay = 0 } = {}) {
		if (!ctx || !on) return;
		const t = ctx.currentTime + delay;
		const o = ctx.createOscillator();
		o.type = type;
		o.frequency.setValueAtTime(freq, t);
		o.frequency.exponentialRampToValueAtTime(Math.max(20, freq1), t + dur);
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * vm), t + 0.008);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		o.connect(g).connect(sfx);
		o.start(t);
		o.stop(t + dur + 0.05);
	}

	function applyMood() {
		if (!ctx) return;
		moodFilter.frequency.setTargetAtTime(mood.cutoff, ctx.currentTime, 0.6);
		clearInterval(drumTimer);
		drumTimer = 0;
		if (mood.drum) drumTimer = setInterval(() => on && tone({ freq: 62, freq1: 34, dur: 0.4, vol: 0.4 }), 520);
		// A sub drone for dread: made once, faded in and out.
		if (mood.drone && on && !droneGain) {
			droneGain = ctx.createGain();
			droneGain.gain.value = 0;
			const lp = ctx.createBiquadFilter();
			lp.type = 'lowpass';
			lp.frequency.value = 160;
			lp.connect(droneGain).connect(master);
			droneOsc = [[41, 'sine'], [61.5, 'triangle']].map(([f, type]) => {
				const o = ctx.createOscillator();
				o.type = type;
				o.frequency.value = f;
				o.connect(lp);
				o.start();
				return o;
			});
		}
		droneGain?.gain.setTargetAtTime(mood.drone ? 0.22 : 0, ctx.currentTime, 1.2);
	}

	const api = {
		resume,
		get on() {
			return on;
		},
		toggle() {
			on = !on;
			if (!ctx) return on;
			master.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.05);
			if (on) {
				applyMood();
				startMusic();
				musicEl?.play().catch(() => {});
			}
			return on;
		},
		// 0 calm .. 1 full fight: the music swells with it.
		setCombat(k, dt) {
			combat += (k - combat) * Math.min(1, dt * (k > combat ? 2 : 0.35));
			moodMul += (mood.mul - moodMul) * Math.min(1, dt * 1.5);
			if (musicGain) musicGain.gain.value = (0.1 + combat * 0.32) * moodMul;
		},
		// The DM's music mood: calm, dread, battle, boss, silence. Anything else clears it.
		music(track) {
			mood = MOODS[track] ?? { mul: 1, cutoff: 20000 };
			applyMood();
		},
		// A sound by the DM's name (schema.js SFX). Unknown names do nothing.
		cue(name, { vol = 1 } = {}) {
			if (!ctx || !on) return;
			const at = (v, fn) => {
				vm = v;
				try {
					fn();
				} finally {
					vm = 1;
				}
			};
			const CUES = {
				rise: () => api.rise(),
				roar: () => api.roar(),
				door: () => api.door(),
				boneBreak: () => api.boneBreak(),
				explode: () => api.explode(),
				shockwave: () => api.shockwave(),
				levelUp: () => api.levelUp(),
				pickup: () => api.pickup(),
				hurt: () => api.hurt(),
				coins: () => play('coins', { vol: 0.8 }),
				// A struck bell: a fundamental with inharmonic partials, ringing out.
				bell: () => {
					[[196, 3.2, 0.22], [196 * 2.4, 2.2, 0.1], [196 * 3.9, 1.5, 0.06], [196 * 5.4, 0.9, 0.04]].forEach(([f, dur, v]) => tone({ freq: f, freq1: f * 0.998, dur, vol: v }));
					noiseHit({ dur: 0.08, f0: 4000, f1: 2500, q: 4, vol: 0.12, attack: 0.002 });
				},
				// Breath with a voice-like band that drifts: two airy passes.
				whisper: () => {
					noiseHit({ dur: 1.9, f0: 2600, f1: 4200, q: 7, vol: 0.14, attack: 0.7 });
					setTimeout(() => ctx && at(vol, () => noiseHit({ dur: 1.6, f0: 3800, f1: 2200, q: 9, vol: 0.1, attack: 0.5 })), 450);
				},
				quake: () => {
					noiseHit({ dur: 2.4, f0: 260, f1: 35, q: 0.5, vol: 0.8, type: 'lowpass', attack: 0.2 });
					tone({ freq: 44, freq1: 24, dur: 2.2, vol: 0.6 });
					for (let i = 0; i < 6; i++) setTimeout(() => ctx && at(vol, () => noiseHit({ dur: 0.18, f0: 600, f1: 120, q: 1, vol: 0.2, type: 'lowpass', attack: 0.01 })), 200 + i * 280 + Math.random() * 120);
				},
			};
			const f = CUES[name];
			if (f) at(vol, f);
		},
		swing(n = 0) {
			noiseHit({ dur: 0.2, f0: 600 + n * 200, f1: 3800, q: 0.9, vol: 0.35 });
			play(n % 2 ? 'slice2' : 'slice', { vol: 0.35, rate: 1.15 });
		},
		hitFlesh(heavy) {
			play(heavy ? 'punch' : 'punch2', { vol: 0.9, rate: 0.85 });
			play('chop', { vol: 0.7, rate: 0.9 });
			noiseHit({ dur: 0.12, f0: 2600, f1: 900, q: 3, vol: 0.25 });
		},
		hitArmor() {
			play('clang', { vol: 0.7, rate: 1.05 });
		},
		crit() {
			play('clang', { vol: 0.9, rate: 0.7 });
			[880, 1320, 1760].forEach((f, i) => tone({ freq: f, dur: 0.9, vol: 0.07, delay: i * 0.03 }));
			tone({ freq: 90, freq1: 40, dur: 0.5, type: 'sine', vol: 0.5 });
		},
		fumble() {
			tone({ freq: 220, freq1: 110, dur: 0.35, type: 'triangle', vol: 0.12 });
		},
		dice() {
			for (let i = 0; i < 5; i++) noiseHit({ dur: 0.03, f0: 3500, f1: 2500, q: 6, vol: 0.12 * (1 - i / 6), attack: 0.002 });
		},
		fireCast() {
			noiseHit({ dur: 0.45, f0: 300, f1: 1800, q: 0.7, vol: 0.5, type: 'lowpass', attack: 0.04 });
			tone({ freq: 140, freq1: 70, dur: 0.4, type: 'sawtooth', vol: 0.06 });
		},
		explode() {
			noiseHit({ dur: 0.9, f0: 1800, f1: 60, q: 0.6, vol: 0.9, type: 'lowpass', attack: 0.005 });
			tone({ freq: 70, freq1: 28, dur: 0.8, vol: 0.7 });
		},
		shockwave() {
			tone({ freq: 55, freq1: 25, dur: 0.9, vol: 0.8 });
			noiseHit({ dur: 0.6, f0: 900, f1: 80, q: 0.5, vol: 0.6, type: 'lowpass' });
		},
		dodge() {
			play('cloth', { vol: 0.8, rate: 1.3 });
			noiseHit({ dur: 0.25, f0: 400, f1: 1400, q: 0.8, vol: 0.25 });
		},
		step() {
			play('step', { vol: 0.22, rate: 0.9, jitter: 0.15 });
		},
		hurt() {
			tone({ freq: 160, freq1: 60, dur: 0.25, type: 'square', vol: 0.08 });
			play('punch', { vol: 0.8, rate: 0.6 });
		},
		rise() {
			for (let i = 0; i < 9; i++) noiseHit({ dur: 0.04, f0: 1800 + Math.random() * 1500, f1: 1200, q: 8, vol: 0.12, attack: 0.002 });
			noiseHit({ dur: 0.8, f0: 200, f1: 90, q: 0.7, vol: 0.3, type: 'lowpass', attack: 0.2 });
		},
		boneBreak() {
			for (let i = 0; i < 6; i++) noiseHit({ dur: 0.05, f0: 2500 + Math.random() * 2500, f1: 1500, q: 7, vol: 0.16, attack: 0.002 });
		},
		roar() {
			tone({ freq: 95, freq1: 60, dur: 1.2, type: 'sawtooth', vol: 0.18 });
			tone({ freq: 140, freq1: 80, dur: 1.1, type: 'sawtooth', vol: 0.1 });
			noiseHit({ dur: 1.2, f0: 500, f1: 200, q: 2, vol: 0.4, attack: 0.15 });
		},
		bolt() {
			tone({ freq: 600, freq1: 1400, dur: 0.3, type: 'triangle', vol: 0.08 });
		},
		pickup() {
			play('coins', { vol: 0.6 });
			tone({ freq: 660, freq1: 990, dur: 0.25, vol: 0.08 });
		},
		levelUp() {
			[392, 523, 659, 784].forEach((f, i) => tone({ freq: f, dur: 1.2, type: 'triangle', vol: 0.09, delay: i * 0.07 }));
		},
		door() {
			play('door', { vol: 0.8, rate: 0.7 });
		},
		draw() {
			play('draw', { vol: 0.7 });
		},
	};
	return api;
}
