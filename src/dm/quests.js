// Host-side quest book. Goals: kill (enemy x n), reach (enter room), cleanse (room_clear), survive (n secs via tick), boss (boss_dead).
// Emits quest_progress / quest_done through onEvent (events are { type, ... }) and pays the reward through pay().
export function createQuests({ onEvent = () => {}, pay = () => {} } = {}) {
	let quests = [];
	const emit = (e) => {
		try { onEvent(e); } catch {}
	};
	const finish = (q) => {
		q.done = true;
		q.k = q.n;
		try { pay(q.reward, q); } catch {}
		emit({ type: 'quest_done', id: q.id });
	};
	const bump = (q, by = 1) => {
		if (q.done) return;
		q.k = Math.min(q.n, q.k + by);
		if (q.k >= q.n) finish(q);
		else emit({ type: 'quest_progress', id: q.id, k: q.k, n: q.n });
	};
	return {
		add(q) {
			if (!q || q.id === undefined || quests.some((x) => x.id === q.id)) return null;
			const n = q.goal === 'kill' || q.goal === 'survive' ? Math.max(1, q.n ?? 1) : 1;
			const nq = { ...q, n, k: 0, party: q.party ?? 1, done: false };
			quests.push(nq);
			return nq;
		},
		observe(e) {
			if (!e) return;
			for (const q of quests) {
				if (q.done) continue;
				if (q.goal === 'kill' && e.type === 'kill' && (!q.enemy || e.enemy === q.enemy)) bump(q);
				else if (q.goal === 'reach' && e.type === 'enter' && e.room === q.room) finish(q);
				else if (q.goal === 'cleanse' && e.type === 'room_clear' && e.room === q.room) finish(q);
				else if (q.goal === 'boss' && e.type === 'boss_dead') finish(q);
			}
		},
		// survive clock: call with frame dt (secs); progress is announced every 5 s
		tick(dt) {
			for (const q of quests) {
				if (q.done || q.goal !== 'survive') continue;
				q.t = (q.t ?? 0) + dt;
				const whole = Math.floor(q.t + 1e-6);
				if (whole > q.k) {
					const before = q.k;
					q.k = Math.min(q.n, whole);
					if (q.k >= q.n) finish(q);
					else if (Math.floor(q.k / 5) > Math.floor(before / 5)) emit({ type: 'quest_progress', id: q.id, k: q.k, n: q.n });
				}
			}
		},
		list: () => quests.map((q) => ({ ...q })),
		toJSON: () => quests.map((q) => ({ ...q })),
		load(json) {
			quests = (Array.isArray(json) ? json : []).filter((q) => q && q.id !== undefined).map((q) => ({ n: 1, k: 0, party: 1, done: false, ...q }));
		},
		// how many characters the open quests want; main sets companions = max(0, wanted - humans)
		partyWanted: () => quests.reduce((m, q) => (q.done ? m : Math.max(m, q.party ?? 1)), 1),
	};
}
