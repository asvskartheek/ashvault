# Ashvault RPG layer — contract

Goal: real characters and real tactics. Every player has a class, a sheet and powers, and can type **any action**; the DM rules on it with a d20 check and the world visibly changes. Builds on docs/DM-ARCHITECTURE.md. Don't build a second combat system: classes are data over the existing kit (sword, fire bolt, shockwave, dodge, potion, boons).

## One effect layer (G owns) — `src/rpg/effects.js`

Everything (class powers, free actions, DM reactions) resolves to these primitives:

| effect | does | shows |
|---|---|---|
| push | knockback from caster/point, power × 4 cells/s impulse, stagger | dust, impact |
| stun | enemy stops acting 1.5 s × power | stars/sparks ring |
| burn | fire zone at point (radius 1 + 0.5·power, 6 s) + damage over time | embers, flame light |
| freeze | enemy frozen 2 s × power, next hit ×2 and shatters | frost tint, ice shards |
| fear | enemies flee from caster 3 s × power | violet wisps |
| lure | enemies walk to a point 4 s × power (ignore players) | bell + soul trail |
| blind | enemies miss / wander 3 s × power | smoke |
| collapse | rubble falls at point: 25·power dmg in radius 1.5, stun 1 s, leaves rubble (blocks cells 20 s) | dust, debris, quake |
| heal | heal target 15·power | green motes |
| ward | target takes −50 % damage 4 s × power | gold shell flash |
| hide | caster unseen by enemies 3 s × power; next melee from hiding ×3 | view darkens at edges |
| smite | radiant/kinetic hit 22·power on target (×2 vs wisp/revenant) | light beam |
| none | narration only | — |

API: `createEffects({ enemies, fx, audio, world, numbers, actors })` → `apply(effect, { caster, target, power, at })`, `update(dt)`, `statusOf(enemy)`.
- target: `'aimed'` (enemy under crosshair, else ray end point), `'nearest'`, `'group'` (enemies within 4 cells of aim point), `'self'`, `'ally'` (nearest other human/bot, else self), or an explicit `{ enemyId }` / `{ x, z }`.
- Enemy statuses live in enemies.js (`e.status = { stun, freeze, fear, blind, burn, lure: {x,z,t}, slow }`), honoured by its AI, and go into snapshot rows as a bitmask so clients draw them.
- Zones (burn, rubble, holy) live in world/api.js with snapshot()/restore().
- Props the player can use (`src/rpg/props.js`): nearest of `pier` (pillar → collapse), `stand` (candle stand → burn small), `ember` (ember basin → burn big), `banner` (→ burn + blind), `bones`/`debris` (→ thrown smite). `findProp(kinds, x, z, maxCells)`; using a prop consumes it (pillar falls, basin empties) visibly.

## Classes (F owns) — `src/rpg/classes.js`, `src/rpg/sheet-ui.js`

| class | key stat | HP / mana | LMB | RMB | Q | R | F |
|---|---|---|---|---|---|---|---|
| Warden (fighter) | STR | 130 / 60 | heavy sword | shield bash (push+stun aimed) | shockwave | war cry (fear group + ward self) | second wind (heal self) |
| Pyromancer (wizard) | INT | 80 / 140 | staff strike | fire bolt | frost nova (freeze group) | blink (dash 5 cells) | ember wall (burn line) |
| Shade (rogue) | DEX | 95 / 80 | twin daggers (fast) | throwing knives (smite aimed, ranged) | smoke (blind group) | shadowstep (hide) | lure (bell at aim point) |
| Cleric | WIS | 110 / 120 | mace | radiant smite (smite aimed) | turn undead (fear group) | sanctuary (heal + ward allies near) | revive ally |

- Stats STR DEX CON INT WIS CHA, standard array per class; mod = floor((s−10)/2); proficiency +2 (+1 per 4 levels). Level-up: +1 to key stat every 2 levels, plus the existing boon pick.
- Each power: `{ id, name, key, icon (inline SVG path), cost: { mana, cd }, effect, target, power, stat }`.
- Sheet panel (Tab): class name, level, stat bars with mods, HP/mana, powers with keys + cooldowns, boons. Visual, no paragraphs.
- Class select at the start (cards, one click), skipped with `?patch-test=1` (default Warden) and selectable by `?class=`.
- Power bar replaces the old ability icons (RMB, Q, R, F, E potion, Space dodge, ↵ act).

## Free actions (H owns DM side)

- Press **Enter** (or T): an input opens with the crosshair target named; solo slows time to 0.2× while typing; ≤ 120 chars. Esc cancels.
- Ruling = one fixed-shape object (schema.js `RULING`): `{ stat, dc ∈ 8..18 step 2, effect, target, power 1–3, pass ≤ 90 chars, fail ≤ 90 chars }`. Code rolls d20 + stat mod + proficiency (crit on 20 → power+1, fumble on 1 → backfire). Pass → `effects.apply`; fail → fail line + small backfire (self stun 0.6 s or 5 dmg) — never nothing.
- Context to the DM: actor (class, stats, hp), aimed enemy + distance, nearby enemies (≤ 5), nearby props (≤ 5, with distance), room role.
- Own queue in dm.js (`dm.act(req) → Promise<ruling>`), not behind react's debounce/gap; timeout 3 s → scripted ruling. Per-player cooldown 5 s. During model warm-up: scripted at once. The d20 roll animation (~1.2 s) covers model latency.
- Scripted ruling (`src/dm/backends/scripted-act.js`): a real verb/noun table (push/shove/kick/bash → push|stun STR; throw → smite DEX; burn/ignite/torch/coals/brazier → burn; topple/collapse/pillar → collapse STR; hide/sneak → hide DEX; pray/bless/heal → heal|ward WIS; shout/taunt/distract/bell → lure CHA; frighten/roar → fear CHA; freeze/ice → freeze INT; smoke/dust/blind → blind DEX; …), choosing a DC from distance/power and writing pass/fail lines from templates with the target's name.
- After applying, the host also feeds `{type:'action', who, what: effect, pass}` to dm.observe so reactions follow.

## Multiplayer (I owns protocol)

- client→host `act { text, aim: {enemyId|x,z}, near }`, `pow { id, aim }` (powers that apply statuses/zones run on the host).
- host→all `rule { who, text, roll, mod, dc, pass, effect, lines }` (everyone sees the roll), statuses in `h` enemy rows (bitmask), zones via world snapshot / `fx`.
- `p` gains `cls` (class index) so avatars tint/label by class.

## Model

Decided by the free-action bench (bench/act): LFM2.5-350M vs 1.2B accuracy on 30 cases. Whichever is picked, grammar-constrained, with the scripted ruling as fallback.
