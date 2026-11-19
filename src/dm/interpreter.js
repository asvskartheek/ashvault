// Runs a validated program against the World API: one call per op (method name = op). `floor` is the builder's, not the world's.
export function run(cmds, world, { actor } = {}) {
	const results = [];
	for (const c of cmds || []) {
		if (!c || c.op === 'floor') continue;
		try {
			const fn = world?.[c.op];
			if (typeof fn !== 'function') {
				results.push({ op: c.op, ok: false, error: 'no such op' });
				continue;
			}
			switch (c.op) {
				case 'role': world.role(c.room, c.as); break;
				case 'guard': world.guard(c.room, c.enemy, c.n, c.level ?? 0); break;
				case 'spawn': world.spawn(c.enemy, c.n, { near: c.near ?? (c.room === undefined ? 'party' : 'room'), room: c.room, level: c.level ?? 0 }); break;
				case 'light': world.light(c.room, c.color, c.power ?? 1.5); break;
				case 'mood': world.mood(c.as); break;
				case 'sfx': world.sfx(c.cue, c.room); break;
				case 'music': world.music(c.track); break;
				case 'bless': world.bless(c.what, c.amount ?? 25, c.who ?? 'all', actor); break;
				case 'curse': world.curse(c.what, c.secs ?? 10, c.who ?? 'all', actor); break;
				case 'seal': world.seal(c.room, c.open !== false); break;
				case 'say': world.say(c.text, c.voice ?? 'dm'); break;
				case 'quest': world.quest({ ...c }); break;
				default: continue;
			}
			results.push({ op: c.op, ok: true });
		} catch (error) {
			results.push({ op: c.op, ok: false, error: String(error?.message ?? error) });
		}
	}
	return results;
}
