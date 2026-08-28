#!/usr/bin/env node
/**
 * Regenerates `evaluation.json`, the accuracy fixture for the part resolver.
 *
 * The accept sets are derived from catalog facts - LDraw names, measured
 * envelopes, connector multisets, connector orientations, LEGO numbering - and
 * not from anything the resolver returned. That is the whole point of keeping
 * this script: an evaluation whose answers were copied out of the system it
 * grades measures nothing, and the only way to keep that honest over time is to
 * be able to rebuild the fixture from the catalog and read the predicates.
 *
 * Every id is checked against the compiled catalog before the file is written,
 * so a rename in a future catalog build fails loudly here rather than quietly
 * lowering recall.
 *
 *   node src/intelligence/parts/__fixtures__/build-evaluation.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()
const search = JSON.parse(readFileSync(`${ROOT}/public/catalog/2026-07/search.json`, 'utf8'))
const parts = JSON.parse(readFileSync(`${ROOT}/public/catalog/2026-07/parts.json`, 'utf8'))
const partById = new Map(parts.map((p) => [p.canonicalId, p]))
const axisOf = (f) => (f.ori ? [f.ori[1], f.ori[4], f.ori[7]] : [0, 1, 0])
const profile = (p) => {
  const counts = new Map()
  for (const f of p.connectors) counts.set(`${f.family}/${f.gender}`, (counts.get(`${f.family}/${f.gender}`) ?? 0) + 1)
  return [...counts.entries()].sort().map(([k, v]) => `${k}:${v}`).join(',')
}
/** Pack parts whose connector multiset equals this one's - a genuine interface match. */
const sameInterface = (id, cap = 30) => {
  const source = partById.get(id)
  const key = profile(source)
  return parts
    .filter((p) => p.canonicalId !== id && profile(p) === key)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, cap)
    .map((p) => p.canonicalId)
}
/** Pack parts carrying a connector of `family` whose axis is horizontal. */
const axisIs = (family, horizontal, cap = 30) =>
  parts
    .filter((p) =>
      p.connectors.some((f) => f.family === family && (Math.abs(axisOf(f)[1]) < 0.5) === horizontal),
    )
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, cap)
    .map((p) => p.canonicalId)
/** Parts whose footprint reaches at least `studs` along one axis. */
const spans = (pattern, studs, cap = 30) => {
  const re = new RegExp(pattern, 'i')
  return search
    .filter((e) => re.test(norm(e.n)) && e.d && Math.max(e.d[0], e.d[2]) >= studs)
    .sort((a, b) => b.f - a.f)
    .slice(0, cap)
    .map((e) => e.id)
}
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const byId = new Map(search.map((e) => [e.id, e]))

/** Accept set from a name pattern, ordered by real-world usage, capped. */
const like = (pattern, { cap = 12, minFrequency = 0, category } = {}) => {
  const re = new RegExp(pattern, 'i')
  return search
    .filter((e) => re.test(norm(e.n)) && e.f >= minFrequency && (!category || e.c === category))
    .sort((a, b) => b.f - a.f)
    .slice(0, cap)
    .map((e) => e.id)
}

/** Accept set from a category pattern, for requests that name a family of parts. */
const inCategory = (pattern, { cap = 30, minFrequency = 0 } = {}) => {
  const re = new RegExp(pattern, 'i')
  return search
    .filter((e) => re.test(e.c) && e.f >= minFrequency)
    .sort((a, b) => b.f - a.f)
    .slice(0, cap)
    .map((e) => e.id)
}

/** Two accept sets merged, each capped on its own so a rare family is not crowded out. */
const union = (...lists) => [...new Set(lists.flat())]

const Q = []
const q = (kind, query, accept, rationale, extra = {}) => Q.push({ query, kind, accept, rationale, ...extra })

// --- identifier ------------------------------------------------------------
q('identifier', '3001', ['3001'], 'Canonical LDraw number.')
q('identifier', 'part 3068b', ['3068b'], 'Canonical number with a noise word.')
q('identifier', '3001.dat', ['3001'], 'LDraw file name.')
q('identifier', '3023', ['3023b'], 'Retired number; LDraw renamed it to 3023b.')
q('identifier', '4497066', ['3001'], 'LEGO element id for Brick 2 x 4.')
q('identifier', '54534', ['3001'], 'LEGO design id recorded for Brick 2 x 4.')
q('identifier', 'what is 87079', ['87079'], 'Canonical number inside a question.')
q('identifier', '30374', ['30374'], 'Bar 4L, the lightsaber blade.')
q('identifier', '2412b', ['2412b'], 'Grille tile with a letter suffix.')
q('identifier', '60592', ['60592'], 'Window 1 x 2 x 2 Flat Front.')
q('identifier', 'brick 3001 please', ['3001'], 'Number with surrounding prose.')
q('identifier', '3070b', ['3070b'], 'Tile 1 x 1 with Groove.')

// --- dimension -------------------------------------------------------------
q('dimension', 'brick 2 x 4', ['3001'], 'The archetypal brick.')
q('dimension', '2x4 brick', ['3001'], 'Compact spelling of the same request.')
q('dimension', '4 by 2 brick', ['3001'], 'Spoken form; footprint is order-insensitive.')
q('dimension', 'plate 2 x 4', ['3020'], 'Plate of the same footprint.')
q('dimension', 'plate 1 x 8', ['3460'], 'Long thin plate.')
q('dimension', 'tile 1 x 2', ['3069b', '3069a'], 'Both mould variants are the part people mean.')
q('dimension', 'tile 2 x 2', ['3068b', '3068a'], 'Groove and no-groove variants.')
q('dimension', '1 x 1 brick', ['3005'], 'Smallest ordinary brick.')
q('dimension', 'a plate six studs long and one wide', ['3666'], 'Plate 1 x 6.')
q('dimension', 'eight stud long plate', ['3460', '3034', '3035'], 'Any plate whose long axis is eight studs.')
q('dimension', 'brick 1 x 6', ['3009'], 'Named length.')
q('dimension', 'plate 4 x 6', ['3032'], 'Rectangular plate.')
q('dimension', 'plate 2 x 2', ['3022'], 'Square plate.')
q('dimension', 'brick 2 x 2', ['3003'], 'Square brick.')
q('dimension', 'a 1 x 2 x 5 brick', like('^Brick 1 x 2 x 5', { cap: 6 }), 'Three-number envelope.')
q('dimension', 'baseplate 32 x 32', ['3811'], 'Large baseplate.')
q('dimension', 'window 1 x 4 x 3', ['60594', '3853'], 'Named window envelope.')
q('dimension', 'sixteen by thirty two baseplate', ['3857'], 'Number words for a baseplate.')
q('dimension', 'plate 1 x 4', ['3710'], 'Common plate.')
q('dimension', 'tile 1 x 8', ['4162'], 'Long tile.')

// --- shape -----------------------------------------------------------------
q('shape', 'smooth flat tile one by two', ['3069b', '3069a'], 'Tile 1 x 2.')
q('shape', 'a cheese slope', ['54200'], 'The nickname for Brick Sloped 30 degrees 1 x 1 x 2/3.')
q('shape', '45 degree slope 2 x 2', ['3039'], 'Brick Sloped 45 2 x 2.')
q('shape', 'inverted slope', like('Sloped Inverted|Slope [A-Za-z]* ?[0-9]+.*Inverted', { cap: 40, minFrequency: 0 }), 'Any common inverted slope.')
q('shape', 'round 1 x 1 brick', ['3062b', '3062a'], 'Brick Round 1 x 1, open and solid stud.')
q('shape', 'round tile 1 x 1', ['98138', '25269', '24246'], 'Tile Round 1 x 1 plus its quarter and half forms.')
q('shape', 'a cone', like('^Cone 1 x 1', { cap: 6 }), 'Small cone.')
q('shape', 'curved slope 2 x 1 with no studs', ['11477'], 'Half bow.')
q('shape', 'a wedge plate', like('^Wedge Plate', { cap: 16, minFrequency: 800 }), 'Any common wedge plate.')
q('shape', 'arch 1 x 6', ['3455', '92950', '15254', '3307'], 'Brick Arch 1 x 6 in its several forms.')
q('shape', 'a panel 1 x 2 x 1', ['4865b', '4865a', '23969', '93095'], 'Panel variants of that envelope.')
q('shape', 'grille tile', like('Grille', { cap: 10, minFrequency: 100 }), 'Tile Special with grille ridges.')
q('shape', 'a dish', like('^Dish', { cap: 12, minFrequency: 200 }), 'Radar dish.')
q('shape', 'headlight brick', ['4070'], 'Brick Special 1 x 1 with Headlight.')
q('shape', 'jumper plate', ['15573', '3794b', '3794a', '87580', '18674', '34103'], 'Offset-stud plates.')
q('shape', 'bracket 1 x 2 to 2 x 2', ['44728', '99207'], 'Bracket of that geometry, upright and inverted.')
q('shape', 'a technic beam', like('^Technic Beam', { cap: 16, minFrequency: 400 }), 'Any common Technic beam.')
q('shape', 'a minifigure head', like('^Minifig Head', { cap: 12, minFrequency: 200 }), 'Plain minifig head shapes.')
q('shape', 'a door', like('^Door ', { cap: 40, minFrequency: 20 }), 'Any door leaf.')
q('shape', 'a ladder', like('^Ladder|Ladder\\)', { cap: 12 }), 'Ladders and ladder-shaped bars.')
q('shape', 'a fence', like('^Fence', { cap: 12 }), 'Fence pieces.')
q('shape', 'roof slope 33 degrees 3 x 2', ['3298'], 'Brick Sloped 33 3 x 2.')
q('shape', 'a turntable', like('^Turntable', { cap: 12, minFrequency: 50 }), 'Rotating base and top plates.')
q('shape', 'a propeller', like('^Propeller', { cap: 12 }), 'Propellers.')
q('shape', 'a wheel', like('^Wheel ', { cap: 40, minFrequency: 100 }), 'Road wheels.')

// --- function --------------------------------------------------------------
q('function', 'something that lets two plates pivot', like('^Hinge Plate', { cap: 16, minFrequency: 400 }), 'Hinge plates are the pivot between two plates.')
q('function', 'a piece that holds a bar so it can rotate', like('with Clip|Clips\\]', { cap: 40, minFrequency: 100 }), 'Clip parts grip a bar.')
q('function', 'a part to mount a stud sideways', like('^Bracket |Studs? [Oo]n .*Side|with Headlight', { cap: 40, minFrequency: 100 }), 'SNOT brackets and side-stud bricks.')
q('function', 'a wheel that fits onto an axle', like('^Wheel .*Axle|^Technic Axle|^Wheel .*with Axle', { cap: 40, minFrequency: 50 }), 'Wheels with axle holes and the axles themselves.')
q('function', 'a plate that bridges a 1 stud gap', spans('^Plate [0-9]+ x [0-9]+$', 3, 30), 'A plate three or more studs long reaches across one.')
q('function', 'something to make a smooth finished surface', like('^Tile ', { cap: 40, minFrequency: 500 }), 'Plain tiles are the finished surface.')
q('function', 'a piece that turns', like('Turntable', { cap: 30, minFrequency: 10 }), 'Turntables.')
q('function', 'a windscreen for a car', like('^Windscreen', { cap: 18, minFrequency: 30 }), 'Windscreens.')
q('function', 'a hinge whose axis points sideways', axisIs('hinge', true, 40), 'Compiled parts whose hinge connector axis is measurably horizontal.')
q('function', 'a part for a chimney', union(like('Chimney', { cap: 20 }), like('^Brick Round |^Cone 1 x 1', { cap: 30, minFrequency: 50 })), 'Round bricks and cones stack into a chimney.')
q('function', 'something to hold a flag', like('Flag', { cap: 40, minFrequency: 5 }), 'Flags, flagpoles and flag holders.')
q('function', 'a piece to make a fence railing', like('^Fence|^Bar 7 x 3', { cap: 12 }), 'Fence and railing bars.')
q('function', 'a part that steers', like('Steering', { cap: 30, minFrequency: 5 }), 'Steering parts.')
q('function', 'a plate a minifigure can stand on', like('^Plate [0-9]+ x [0-9]+$|^Plate Special 2 x 2', { cap: 30, minFrequency: 500 }), 'Plates a minifigure stands on.')
q('function', 'a lightsaber blade', ['30374'], 'Bar 4L.')
q('function', 'a piece that connects two technic beams', like('^Technic Pin|^Technic Connector|^Technic Axle Pin', { cap: 40, minFrequency: 100 }), 'Technic pins and connectors.')
q('function', 'a smooth tile that covers a stud so nothing can stack on it', like('^Tile ', { cap: 40, minFrequency: 500 }), 'A tile is what stops stacking.')
q('function', 'a part that makes a corner between two walls', like('^Brick 1 x 1$|^Brick 2 x 2 Corner|^Plate 2 x 2 Corner', { cap: 10 }), 'Corner bricks and 1 x 1 bricks.')
q('function', 'a transparent piece for a window opening', like('^Glass for Window|^Window Pane', { cap: 14, minFrequency: 20 }), 'Glazing panes.')
q('function', 'a part that clips onto a bar and holds a tile', like('with Clip', { cap: 18, minFrequency: 800 }), 'Clip parts.')

// --- colour / finish -------------------------------------------------------
q('color', 'a transparent windscreen about six studs wide', like('^Windscreen 6 x|^Windscreen [0-9]+ x 6', { cap: 14 }), 'Windscreens with a six-stud axis.')
q('color', 'a red 2 x 4 brick', ['3001'], 'Colour is a palette constraint; the part is still Brick 2 x 4.')
q('color', 'trans clear 1 x 1 round brick', ['3062b', '3062a'], 'The part; transparency is the colour.')
q('color', 'a chrome minifigure accessory', inCategory('^Minifig (Accessories|Headwear|Shields)', { cap: 60, minFrequency: 10 }), 'Chrome is a finish, not a part; any catalogued minifig accessory qualifies.')
q('color', 'glow in the dark 1 x 1 plate', ['3024'], 'Plate 1 x 1.')
q('color', 'a pearl gold 1 x 1 round tile', ['98138'], 'Tile Round 1 x 1.')
q('color', 'transparent 1 x 2 plate', ['3023b'], 'Plate 1 x 2.')
q('color', 'a white tile 2 x 4', ['87079'], 'Tile 2 x 4 with Groove.')
q('color', 'dark bluish grey plate 1 x 4', ['3710'], 'Plate 1 x 4.')
q('color', 'trans red 1 x 1 round plate', like('^Plate Round 1 x 1', { cap: 8, minFrequency: 200 }), 'Round 1 x 1 plates.')
q('color', 'a rubber tyre', like('^Tyre', { cap: 16, minFrequency: 200 }), 'Tyres are the rubber parts.')
q('color', 'a transparent 1 x 2 tile', ['3069b', '3069a'], 'Tile 1 x 2.')

// --- connector -------------------------------------------------------------
q('connector', 'clip that holds a bar', like('with Clip|Clips\\]', { cap: 20, minFrequency: 400 }), 'Parts with a clip connector.')
q('connector', 'a brick with a technic pin hole', like('^Technic Brick 1 x [0-9]+$|^Technic Brick 1 x [0-9]+ with', { cap: 16, minFrequency: 300 }), 'Technic bricks carry pin holes.')
q('connector', 'a plate with a pin on the bottom', like('with Pin on Bottom|with 1 Pin', { cap: 12 }), 'Pin-bearing plates.')
q('connector', 'an axle', like('^Technic Axle [0-9]+$', { cap: 14 }), 'Plain axles.')
q('connector', 'part with an axle hole', like('Axle ?[Hh]ole', { cap: 20, minFrequency: 800 }), 'Parts with an axle hole.')
q('connector', 'a ball joint', like('Ball Joint|Towball|^Technic Ball', { cap: 16, minFrequency: 100 }), 'Ball and socket parts.')
q('connector', 'a bar one stud long', like('^Bar 1L|^Bar 1 x', { cap: 10 }), 'Short bars.')
q('connector', 'a socket for a ball', like('Socket', { cap: 16, minFrequency: 50 }), 'Socket parts.')
q('connector', 'brick with studs on the side', ['87087', '11211', '4070'], 'Side-stud bricks.')
q('connector', 'a hinge brick', like('^Hinge Brick', { cap: 14, minFrequency: 100 }), 'Hinge bricks.')
q('connector', 'a technic pin with friction', like('^Technic Pin.*Friction', { cap: 12 }), 'Friction pins.')
q('connector', 'a plate with a clip on top', like('^Plate Special 1 x [0-9] with Clip', { cap: 14, minFrequency: 100 }), 'Clip plates.')
q('connector', 'a bar with clips at both ends', like('Double Clips|with 2 Clips', { cap: 12 }), 'Double clip bars.')
q('connector', 'a tile with a bar handle', like('^Tile Special 1 x [0-9] with (Handle|Clip)', { cap: 14, minFrequency: 100 }), 'Handled tiles.')
q('connector', 'a piece with an anti stud underneath and no stud on top', like('^Tile ', { cap: 40, minFrequency: 500 }), 'A tile is exactly that.')

// --- relation --------------------------------------------------------------
q('relation', 'the mirrored counterpart of wedge 41747', ['41748'], 'LDraw pairs 41747 Right with 41748 Left.')
q('relation', 'mirror of 43710', ['43711'], 'Sloped 4 x 2 Triple Left and Right.')
q('relation', 'the other hand of 29119', ['29120'], 'Stud notch wedge pair.')
q('relation', 'mirrored version of 41767', ['41768'], 'Angled 4 x 2 Right and Left.')
q('relation', 'the mirror of 43723a', like('^Wedge Plate 3 x 2 (Left|Right)', { cap: 6 }), 'Wedge Plate 3 x 2 pair.')
q('relation', 'something cheaper and more common with the same connections as 3068b', sameInterface('3068b', 30), 'Parts whose connector multiset is identical to Tile 2 x 2.')
q('relation', 'a part with the same connectors as 3070b', sameInterface('3070b', 30), 'Parts whose connector multiset is identical to Tile 1 x 1.')
q('relation', 'interchangeable with 3020', sameInterface('3020', 30), 'Parts whose connector multiset is identical to Plate 2 x 4.')
q('relation', 'a part that bridges a 3-stud gap between two plates', spans('^Plate [0-9]+ x [0-9]+$', 5, 30), 'A plate at least five studs long reaches across three.')
q('relation', 'a part that bridges a 6-stud gap', spans('^Plate [0-9]+ x [0-9]+$|^Brick 1 x [0-9]+$|^Tile [0-9]+ x [0-9]+', 8, 30), 'Any part at least eight studs long.')
q('relation', 'a plain unprinted version of 3069bp73', ['3069b'], 'The base design the print decorates.')
q('relation', 'the base design behind 3068bd09', ['3068b'], 'Sticker variant to base.')
q('relation', 'mirror of 78443', like('^Wedge Plate 6 x 2 (Left|Right)', { cap: 6 }), 'Wedge Plate 6 x 2 pair.')
q('relation', 'the mirrored counterpart of 5091', ['5092'], 'Tile 1 x 2 with Stud Notch, left and right.')
q('relation', 'the left hand version of 41769a', like('^Wedge Plate 4 x 2 (Left|Right)|^Wedge Plate 2 x 4', { cap: 8 }), 'Wedge Plate 4 x 2 pair.')

// --- impossible ------------------------------------------------------------
const impossible = (query, unmatched, rationale) =>
  Q.push({ query, kind: 'impossible', accept: [], expectUnmatched: unmatched, rationale })

impossible('a 40-stud transparent gear', ['40 studs'], 'No gear is forty studs across.')
impossible('a 30 stud wide minifigure head', ['30 studs'], 'Minifig heads are one stud.')
impossible('a chrome liquid antigravity brick', ['antigravity'], 'Antigravity is not LEGO vocabulary.')
impossible('a 64 stud long 1 x 1 round brick', ['64 studs'], 'Round 1 x 1 bricks are one stud.')
impossible('a transparent rubber tyre 50 studs across', ['50 studs'], 'No tyre is fifty studs.')
impossible('a flurbulator', ['flurbulator'], 'Invented word.')
impossible('a 25 stud tall cheese slope', ['25 studs'], 'The cheese slope is one stud.')
impossible('a zorbulon plate', ['zorbulon'], 'Invented word.')
impossible('a 48 stud wide minifigure hand', ['48 studs'], 'Minifig hands are sub-stud.')
impossible('a snorklewhacker with twelve clips', ['snorklewhacker'], 'Invented word.')

// --- validate --------------------------------------------------------------
const problems = []
for (const entry of Q) {
  if (!entry.accept.length && entry.kind !== 'impossible') problems.push(`${entry.query}: empty accept set`)
  for (const id of entry.accept) if (!byId.has(id)) problems.push(`${entry.query}: unknown id ${id}`)
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}

const answerable = Q.filter((e) => e.kind !== 'impossible')
console.log(`queries ${Q.length} (answerable ${answerable.length}, impossible ${Q.length - answerable.length})`)
const kinds = new Map()
for (const e of Q) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1)
console.log([...kinds].sort())
console.log('accept size: min', Math.min(...answerable.map((e) => e.accept.length)), 'max', Math.max(...answerable.map((e) => e.accept.length)))

writeFileSync(
  `${ROOT}/src/intelligence/parts/__fixtures__/evaluation.json`,
  `${JSON.stringify({ catalogVersion: '2026-07', queries: Q }, null, 2)}\n`,
)
