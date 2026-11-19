# Ashvault

A first-person fight down through a crypt that is forged fresh in the browser on every floor.

![Knights rising in the crypt](shot-knights.jpg)
![The ogre warden](shot-warden.jpg)

## Play

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5394.

| URL flag | Effect |
|---|---|
| `?mute` | start silent |
| `?seed=123` | fix the dungeon layout |
| `?q=low\|medium\|high` | render quality |
| `?debug` | exposes `window.__g` for stepping frames |

## Controls

| Action | Keyboard / mouse | Controller |
|---|---|---|
| Move / look | WASD / mouse | left / right stick |
| Sword | LMB | right trigger |
| Fire bolt | RMB | left trigger |
| Dodge | Space | bottom button |
| Shockwave | Q | left button / shoulder |
| Potion | E | top button |
| Sprint | Shift | — |
| Pause / sound | P / M | start / — |

## Rules

- Every hit rolls a d20: 20 is a critical, 1 a glancing blow.
- Level-ups offer one of three boons.
- Each floor: rooms of the risen dead, a shrine, treasure, and an ogre warden whose death opens the way down.

## Layout

| Path | What |
|---|---|
| `src/main.js` | game loop, player, HUD, floors |
| `src/game/` | enemies, weapon, audio, effects |
| `src/dungeon/` | Patch "Realistic Procedural Dungeons" block: generator, masonry, lighting |
| `public/assets/` | models, materials, sounds |
| `patch.json` | Patch deploy manifest |

## Build

```bash
npm run build
```

Output goes to `dist/`, which is what Patch deploys.

## Credits

Built on Patch blocks and CC0 / CC-BY assets. Full credits and licences: [public/CREDITS.md](public/CREDITS.md), `public/assets/*/CREDITS.md`, [LICENSE](LICENSE).
