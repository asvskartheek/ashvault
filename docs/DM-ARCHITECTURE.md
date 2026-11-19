# Ashvault DM — architecture contract

Every module below is owned by one agent. Agents touch only their files. Shared contract: `src/dm/schema.js` (do not edit without the orchestrator).

## Hard constraints

- **Local only.** No network LLM. DM backends, in order: Chrome Prompt API (`LanguageModel`, Gemini Nano) → Liquid LFM2.5-350M q4f16 ONNX in a WebGPU worker (transformers.js, weights self-hosted under `public/models/`, gitignored, fetched by `tools/fetch-model.mjs`) → scripted DM. Always feature-detect; never assume.
- **Patch CSP:** `connect-src 'self'`. Nothing from CDNs. transformers.js: `env.allowRemoteModels = false`, `env.localModelPath = './models/'`, ORT wasm served from our own files.
- **DM output = world code only.** A JSON array of commands from `schema.js` `OPS`. It composes existing themes, enemies, sounds, lights. Never `eval`. Always `validate()`.
- **Only the host runs the DM.** Host validates, applies, broadcasts the program. Clients apply the same validated program. Programs are tiny, so they also go in the room's shared log for late joiners.
- **Frame time first.** Generation runs in a worker / async, never blocks the frame. The DM plans ahead (floor genesis during the loading screen; reactions in short programs, ≤ 160 output tokens). One generation in flight at a time. Timeout → scripted fallback.
- **Patch test** (`?patch-test=1`): solo, scripted DM, existing checks (`level-loads`, `enemy-rises`, `sword-hits`, `fireball-hits`, `enemy-killed`) must still pass, plus new `dm-genesis`, `dm-react`.
- **1 to 12 players.** Solo works offline with no `window.patch`. A mission may declare `party: n`; the host fills the gap with AI companions (scripted bots, not LLM).
- Testing is always muted (`?mute`). `?debug` exposes `window.__g.step(n)`.

## Module map

| Owner | Files | Exports |
|---|---|---|
| orchestrator | `src/dm/schema.js` | `OPS`, enums, `programSchema()`, `validate(program, {rooms, genesis})`, `parseLoose(text)` |
| A · DM core | `src/dm/dm.js`, `src/dm/prompt.js`, `src/dm/interpreter.js`, `src/dm/quests.js`, `src/dm/backends/scripted.js`, `tools/dmtest.mjs` | see below |
| B · local LLM | `src/dm/backends/prompt-api.js`, `src/dm/backends/lfm.js`, `src/dm/backends/lfm-worker.js`, `src/dm/backends/pick.js`, `tools/fetch-model.mjs`, `bench/dm.html`, `bench/dm.js`, `package.json` (deps only), `vite.config.mjs` | backend objects |
| C · net | `src/net/session.js`, `src/net/protocol.js`, `src/net/avatars.js`, `tools/nettest.mjs` | session, codec, avatars |
| D · party | `src/party/bots.js`, `src/game/enemies.js` (multi-target) | companions |
| E · world | `src/world/api.js`, `src/game/audio.js` (new cues + music moods) | `createWorldAPI(deps)` |
| integration | `src/main.js`, `index.html` | wiring, lobby, HUD |

## Interfaces

### Backend (A writes scripted, B writes the LLM ones)

```js
backend = {
  name: 'prompt-api' | 'lfm' | 'scripted',
  async ready(),                    // true when it can generate now
  async generate(req, { signal }),  // → string (JSON text of a program)
}
req = { kind: 'genesis' | 'react', system, prompt, schema, maxTokens, state, events }
// LLM backends use system/prompt/schema. scripted uses state/events (structured) and ignores the text.
```

`pick.js` → `async pickBackend({ allowLLM }) → backend` (prompt-api if `availability()==='available'`, else lfm if `navigator.gpu` and model files present via HEAD `./models/lfm2.5-350m/onnx/model_q4f16.onnx`, else scripted). `?dm=scripted|prompt|lfm` forces one.

### DM agent (A)

```js
const dm = createDM({ backend, fallback /* scripted backend */, onProgram(cmds, meta) });
await dm.genesis({ floor, seed, party: [{id,name,bot}], rooms: [{id,type,w,h}], story }) // → validated cmds incl. one `floor` op, roles, guards, ≥1 quest, music, say. ≤ 6 s, else fallback.
dm.observe(event)        // events below; dm decides when to react (debounce ~1.5 s, priority events react sooner)
dm.tick(dt)              // emits 'lull' itself after ~20 s of no events
dm.story                 // ≤ 600 char running summary, carried across floors
dm.stop()
```

Events: `{t:'enter', room, role, who}`, `{t:'kill', enemy, room, who}`, `{t:'room_clear', room}`, `{t:'down', who}`, `{t:'low_hp', who}`, `{t:'quest_progress', id, k, n}`, `{t:'quest_done', id}`, `{t:'boss_dead'}`, `{t:'shrine', who}`, `{t:'treasure', who}`, `{t:'lull', secs}`, `{t:'join', who}`, `{t:'leave', who}`, `{t:'action', who, what}` (dodge spam, potion, shockwave, etc.). `who` is a player name.

Prompts: system prompt lists the ops compactly with enums + 2 few-shot programs; prompt = floor facts, party, quest state, last ≤ 8 events, story. Ask for "a JSON array only".

### Interpreter (A)

`run(cmds, world, { actor })` calls the World API, one method per op (names = op names). `floor` op is not run by the interpreter: `genesis` returns it and main builds the floor with it.

`quests.js`: `createQuests({ onEvent })` → `{ add(q), complete(id), observe(event), list(), toJSON(), load(json) }`. Tracks `kill` (enemy type count), `reach` (enter room), `cleanse` (room_clear), `survive` (secs), `boss` (boss_dead). Emits `quest_progress` / `quest_done` events back into the DM.

### World API (E)

```js
const world = createWorldAPI({ view, dungeon, enemies, fx, audio, hud, party, R, spawnAt, roomCells });
world.role(room, as) · guard(room, enemy, n, level) · spawn(enemy, n, {near, room, level}) · light(room, color, power)
world.fog(color, density) · mood(as) · sfx(cue, room) · music(track) · shake(power)
world.bless(what, amount, who, actorId) · curse(what, secs, who, actorId) · seal(room, open)
world.say(text, voice) · quest(q) · complete(id, reward) · companions(n)
world.update(dt)   // fades lights/fog/curses over time
```
`hud` is `{ say(text, voice), quests(list), banner(text, secs), shake(k), flash(r,g,b,k) }`, provided by main.
Audio: add cues `bell`, `whisper`, `quake` (synthesised, no new files) and `music(track)` moods layered over the existing music file (`calm` low-pass, `dread` low + drone, `battle` full, `boss` full + drums synth, `silence` fade out).

### Session (C)

```js
const s = await createSession({ max: 12 });   // Patch rooms if window.patch; ?room=local-ABC → BroadcastChannel shim (multi-tab dev); else solo
s.mode            // 'patch' | 'local' | 'solo'
s.me              // { id, name }
s.players         // [{ id, name, host }]
s.isHost, s.code
s.on('msg' | 'join' | 'leave' | 'host' | 'shared', fn)
s.send(type, payload, { to })   // ≤ 16 KB, rate-limited internally to ≤ 25 msg/s
s.setShared(obj)  // host only, ≤ 16 KB
s.shared, s.now(), s.invite(), s.leave()
```

Protocol (`protocol.js`): `p` player state 15 Hz (x,z,y,yaw,pitch,anim,hp, quantised); `e` enemy snapshot host→all 10 Hz (id,type,x,z,yaw,hp,anim); `hit` client→host {eid,dmg,crit,kind}; `dmg` host→client; `prog` host→all {seq, cmds}; `fx` one-shot effects; `bot` companion states (same shape as `p`). Shared data: `{ seed, floor, name, theme, quests, log: [last 20 {seq,cmds}] }`.

`avatars.js`: `createAvatars({ scene, assets, env })` → `{ upsert(id, state, {name, color, bot}), remove(id), update(dt) }` — knight model, per-player tint, name tag sprite, interpolated 100 ms behind.

### Party (D)

`createCompanions({ dungeon, enemies, fx, audio, floorY })` → `{ setCount(n, around), list, update(dt, humans), states() }`. Host-run. Each bot: follow nearest human (BFS on `dungeon.grid`), engage nearest enemy within 7 cells, sword in reach, fire bolt at range, retreat when low. Enemies target the nearest of all actors: `enemies.setTargets([{ id, x, z, alive }])` (multi-source distance field) and `enemies.onHitActor = (enemy, targetId, dmg, kind)`; existing single-player behaviour unchanged when one target.
