// 30 free-text player actions with the context the DM would see and the expected ruling (effect may accept alternatives).
const WAR = 'Kael warrior STR 16 DEX 10 INT 8 WIS 9 CON 14 CHA 10';
const ROG = 'Mira rogue STR 9 DEX 16 INT 11 WIS 10 CON 10 CHA 13';
const MAG = 'Orin mage STR 7 DEX 11 INT 16 WIS 13 CON 9 CHA 10';
const CLE = 'Sela cleric STR 11 DEX 9 INT 10 WIS 16 CON 13 CHA 12';
const c = (actor, aimed, enemies, props, text, stat, effect) => ({ ctx: `Actor: ${actor}\nAimed at: ${aimed}\nEnemies: ${enemies}\nProps: ${props}`, text, stat, effect: [].concat(effect) });
export const CASES = [
	c(ROG, 'knight 6m', 'knight 6m, knight 7m, wisp 14m', 'ember basin 2m, pillar 5m', 'I kick the brazier coals onto the knights', 'dex', 'burn'),
	c(WAR, 'ogre 5m', 'ogre 5m, hollow 9m', 'stone pillar 3m, bones 2m', 'I topple the pillar onto the ogre', 'str', 'collapse'),
	c(ROG, 'none', 'knight 5m, knight 6m, hollow 8m', 'candle stand 3m; ally Mira 4m', 'I shout a challenge to draw them off Mira', 'cha', 'lure'),
	c(CLE, 'none', 'none', 'fallen ally Dren 1m, candle stand 2m', 'I pray over the fallen', 'wis', 'heal'),
	c(ROG, 'knight 8m', 'knight 8m, knight 9m', 'pillar 2m, banner 6m', 'I hide behind the pillar', 'dex', 'hide'),
	c(WAR, 'wisp 7m', 'wisp 7m, hollow 10m', 'torch in hand, bones 3m', 'I throw my torch at the wisp', 'dex', 'burn'),
	c(ROG, 'knight 3m', 'knight 3m, hollow 6m', 'ash heap 1m, bones 2m', "I hurl a handful of ash into the knight's eyes", 'dex', 'blind'),
	c(WAR, 'hollow 6m', 'hollow 6m, hollow 7m, hollow 9m', 'candle stand 2m, debris 4m', 'I smash the candle stand down to block the corridor', 'str', ['collapse', 'push']),
	c(MAG, 'hollow 5m', 'hollow 5m, hollow 6m, hollow 7m', 'ember basin 3m, cracks 4m', 'I knock the ember basin so it spills toward the hollows', 'dex', 'burn'),
	c(WAR, 'ogre 4m', 'ogre 4m', 'tattered banner 2m, pillar 6m', "I rip the banner down and wrap it over the ogre's head", 'str', ['blind', 'stun']),
	c(WAR, 'none', 'knight 7m, knight 8m, hollow 9m', 'bones 2m', 'I howl a terrible war cry to scare them', 'cha', 'fear'),
	c(WAR, 'hollow 5m', 'hollow 5m, hollow 6m, wisp 9m', 'cracked ceiling above, cracks 1m', 'I stomp the cracked floor to bring the ceiling down on them', 'str', 'collapse'),
	c(CLE, 'none', 'knight 9m', 'ally Mira 2m (wounded)', 'I whisper a ward of protection around Mira', 'wis', 'ward'),
	c(WAR, 'knight 2m', 'knight 2m, knight 5m', 'pillar 4m', 'I shove the nearest knight back with my shield', 'str', 'push'),
	c(ROG, 'none', 'wisp 14m, hollow 6m', 'bones 1m, candle stand 4m', 'I hurl a bone at the far wisp to draw its attention', 'dex', 'lure'),
	c(MAG, 'hollow 4m', 'hollow 4m, hollow 5m', 'puddle of water 3m', 'I freeze the puddle with my frost rune', 'int', 'freeze'),
	c(CLE, 'none', 'none', 'ally Dren 2m (wounded), candle stand 3m', 'I recite the old burial rite over Dren', 'wis', ['heal', 'ward']),
	c(CLE, 'none', 'none', 'ally Mira 1m (bleeding), banner 3m', "I bind Mira's wound with a strip of the banner", 'wis', 'heal'),
	c(WAR, 'hollow 3m', 'hollow 3m, hollow 4m, hollow 6m', 'cracked floor 1m', 'I slam my hammer down on the cracked floor to stun the hollows', 'str', 'stun'),
	c(ROG, 'none', 'knight 7m, wisp 10m', 'candle stand 2m, candle stand 4m, pillar 5m', 'I vanish into the shadows between the candle stands', 'dex', 'hide'),
	c(MAG, 'knight 8m', 'knight 8m, knight 10m', 'glyph-carved pillar 3m', 'I read the glyph on the pillar and unleash its light', 'int', ['smite', 'blind']),
	c(CLE, 'ogre 3m', 'ogre 3m, hollow 8m', 'altar 4m', 'I strike the ogre with all my holy might', 'str', 'smite'),
	c(WAR, 'knight 6m', 'knight 6m, knight 7m', 'burning brazier 2m', 'I endure the flames and charge through the brazier', 'con', ['burn', 'none', 'smite', 'push']),
	c(ROG, 'knight 5m', 'knight 5m', 'bones 2m', 'I taunt the knight with an insulting rhyme', 'cha', 'lure'),
	c(ROG, 'none', 'wisp 6m, knight 9m', 'candle stand 2m, candle stand 3m, candle stand 5m', 'I snuff the candles so the room goes dark', 'dex', ['hide', 'blind']),
	c(WAR, 'hollow 8m', 'hollow 8m, hollow 9m, hollow 11m', 'debris pile 2m, doorway 6m', 'I drag the debris pile into the doorway', 'str', ['collapse', 'ward']),
	c(CLE, 'ogre 4m', 'ogre 4m', 'bones 3m', 'I stare down the ogre and refuse to blink', 'cha', 'fear'),
	c(MAG, 'hollow 5m', 'hollow 5m, hollow 6m, hollow 8m', 'ember basin 2m', "I fling the ember basin's coals at the hollows", 'dex', 'burn'),
	c(CLE, 'none', 'knight 9m', 'ally Mira 2m, ally Kael 3m', 'I rally the party with a battle hymn', 'cha', ['ward', 'heal']),
	c(MAG, 'knight 8m', 'knight 8m, knight 9m, hollow 11m', 'cracked ceiling 5m, keystone above pillar 4m', 'I work out where the ceiling is weakest and strike the keystone', 'int', 'collapse'),
];
