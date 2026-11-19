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

## Interfaces (revised after Fable's review)

### Palettes, not layout themes
Only the generator's crypt rules build the vaulted crypt. The floor is always generated with theme `verdant`; the DM's `floor.palette` (one of the 5 `THEMES` looks) is laid over it: torch colour, fog, hemi/dir light, particles, pool colours. E owns making this work (pass `params.palette` through the build worker into `bakeField` / `level.js` colour lookups, keep the generator's rules `verdant`).

### Program kinds (`schema.js` `KINDS`)
| kind | when | ops | max |
|---|---|---|---|
| `plan` | floor start, before building | floor, say, music, mood | 4 |
| `populate` | floor built | role, guard, quest, light, seal, say, music, mood | 12 (overrides only; generator defaults stand) |
| `react` | after events | spawn, light, mood, sfx, music, bless, curse, say, quest | 4 |

`validate(program, { kind, rooms, locked })`. `locked` = entrance + boss room ids. `programSchema(kind, rooms)` for constrained decoding. `NEED`, `GOAL_NEED`, `HOST_ONLY`, `COLORS` (named colours → hex) exported. Zero valid cmds from an LLM → use the scripted backend's program instead.

### Backend (A writes scripted, B writes the LLM ones)
```js
backend = {
  name: 'prompt-api' | 'lfm' | 'scripted',
  async ready(),                         // can generate now
  async warm(kind, system, schema),      // optional: build/keep a session whose prefix is the static system prompt for this kind
  async generate(req, { signal }),       // → string (JSON text of a program)
}
req = { kind, system, prompt, schema, maxTokens, state, events }
// system is STATIC per kind (prefix reuse). LLM backends use system/prompt/schema; scripted uses state/events and ignores text.
```
`pick.js` → `async pickBackend() → backend`: prompt-api if `LanguageModel.availability()==='available'`; else lfm if `navigator.gpu` and HEAD `./models/lfm2.5-350m/onnx/model_q4f16.onnx_data` ok; else scripted. `?dm=scripted|prompt|lfm` forces one. Patch test → scripted.

### DM agent (A) — host only
```js
const dm = createDM({ backend, fallback, onProgram(cmds, meta) });   // meta = { seq, kind, backend, ms, actor }
const planCmds = await dm.plan({ floor, seed, party: [{id,name,bot}], story });     // ≤ 4 s else fallback; always contains one `floor` cmd
// main builds the floor from the floor cmd, then:
const popCmds = await dm.populate({ rooms: [{id,type,w,h,depth}], locked, party });  // ≤ 6 s else fallback; ≥ 1 quest
dm.observe(event)   // react: debounce ~1.5 s, priority events (down, boss_dead, quest_done, join) sooner; one generation in flight
dm.tick(dt)         // emits 'lull' itself after ~20 s quiet
dm.story            // ≤ 600 chars, written by CODE from events + quests (not by the model); carried across floors
dm.stop()
```
Events (`who` = player id; names resolved by prompt.js from party): `enter{room,role,who}`, `kill{enemy,room,who}`, `room_clear{room}`, `down{who}`, `low_hp{who}`, `quest_progress{id,k,n}`, `quest_done{id}`, `boss_dead`, `shrine{who}`, `treasure{who}`, `lull{secs}`, `join{who}`, `leave{who}`, `action{who,what}`.

`prompt.js`: `systemFor(kind)` static (op list with enums + 1 short few-shot per kind, ≤ 700 tokens), `promptFor(kind, state, events)` (≤ 300 tokens: floor facts, party, quests, last ≤ 6 events, story). Max output: plan 96, populate 320, react 128 tokens.

### Interpreter (A)
`run(cmds, world, { actor })` → one World API call per op (method name = op). `floor` is not run: `plan` returns it and main builds with it. `quest` → `world.quest(q)`; quests.js owns progress and pays `reward`.

`quests.js` (host): `createQuests({ onEvent, pay(reward) })` → `{ add(q), observe(event), list(), toJSON(), load(json), partyWanted() }`. Goals: kill (enemy type count n), reach (enter room), cleanse (room_clear room), survive (n secs, host clock), boss (boss_dead). Emits `quest_progress` / `quest_done` back to the DM. `partyWanted()` = max `party` of open quests → host sets companion count = max(0, wanted − humans).

### World API (E)
```js
const world = createWorldAPI({ view, dungeon, enemies, fx, audio, hud, R, authority /* bool: host? */, spawnAt, roomCells, partyPos });
// effect ops (everyone): light, mood, sfx, music, say
// HOST_ONLY ops (no-op when !authority): role, guard, spawn, bless, curse, seal, quest
world.role(room, as)                // writes dungeon.rooms[room].type
world.guard(room, enemy, n, level)  // writes dungeon.rooms[room].roster = [{enemy,n,level}]; main's wake() spawns roster if present, else its old defaults
world.spawn(enemy, n, { near, room, level }) · light(room, color, power) · mood(as) · sfx(cue, room) · music(track)
world.bless(what, amount, who, actorId) · curse(what, secs, who, actorId) · seal(room, open) · say(text, voice) · quest(q)
world.update(dt)            // fades lights, mood transitions, curse timers
world.snapshot() / restore(s)  // persistent effects only (room lights, mood, music, seals, roles, curses) — for late joiners, ≤ 4 KB
world.applyPalette(name)    // at build time
```
`hud` = `{ say(text, voice), quests(list), banner(text, secs), shake(k), flash(r,g,b,k) }` from main.
Audio (E): add `audio.cue(name, { vol })` covering every `SFX` name (existing sounds + synthesised `bell`, `whisper`, `quake`), and `audio.music(track)` setting a mood multiplier/filter that `setCombat` respects (it currently overwrites gain every frame).

### Session (C)
```js
const s = await createSession({ max: 12 });   // Patch rooms if window.patch; ?room=local-ABC → BroadcastChannel shim (multi-tab dev); else solo
s.mode ('patch'|'local'|'solo'), s.me {id,name}, s.players [{id,name,host}], s.isHost, s.code
s.on('msg'|'join'|'leave'|'host'|'shared'|'close', fn)
s.send(type, payload, { to })   // ≤ 16 KB; internal token bucket ≤ 25/s, drops lowest-priority state first
s.setShared(obj)                // host only, ≤ 16 KB
s.shared, s.now(), s.invite(), s.leave()
```
Protocol (`protocol.js`, encode/decode + size guards):
- client→host: `p` own state 12 Hz (x,z,y,yaw,pitch,anim,hp; quantised), `hit {eid,dmg,crit,kind}`, `ev {event}` (enter/action/shrine/treasure/low_hp/down for the DM).
- host→all: `h` ONE bundled tick 10 Hz `{ t, p: [players incl. host], e: [enemies: id,type,x,z,yaw,hp,anim], b: [bots] }` — must fit 16 KB at 12 players + 30 enemies + 11 bots (quantise to ints); `prog {seq, kind, cmds, actor}`; `dmg {to, dmg, kind}`; `fx {...}` one-shots.
- shared (host `setShared`): `{ seed, floor, floorCmd, populate /*validated cmds*/, world: world.snapshot(), quests: quests.toJSON(), seq }`. Late joiner: build floor from seed+floorCmd, apply populate effect ops, restore world snapshot, load quests; no replay of one-shots.
- Host migration: new host has the last `h` + shared; it takes over enemies from the last snapshot, starts a DM with `pickBackend()` and `dm.story` from shared.

`avatars.js`: `createAvatars({ scene, assets, env })` → `{ upsert(id, state, {name, color, bot}), remove(id), update(dt), clear() }` — knight model, per-player tint, name tag sprite, interpolated ~100 ms behind.

### Party + enemies (D)
`createCompanions({ dungeon, enemies, fx, audio, floorY })` → `{ setCount(n, around), list, update(dt, humans), states() }`. Host-run, scripted: follow nearest human (BFS on grid), engage nearest enemy within 7 cells, sword in reach, fire bolt at range, back off when low, downed bots revive at room clear.
`enemies.js`: `setTargets([{ id, x, z, alive }])` (multi-source distance field; each enemy chases/attacks the nearest target); `update(dt, hooks)` uses the targets (keep `update(dt, player, hooks)` working: a player arg means one target with id 'me'); `hooks.hitActor(enemy, targetId, dmg, kind)` when it hits a non-'me' target; client puppet mode `applySnapshot(list)` (create/move/animate/kill to match host, no AI); `snapshot()` → compact list for `h`; `damage` by id for host applying client `hit`s.
