/**
 * GENERATED FILE — do not edit.
 *
 * Written by `tools/build-demos.mjs` from the compiled catalog and the CAD
 * kernel. Every entry here passed the gates listed in `DEMO_MANIFEST.gates`
 * before it was allowed into this file; a demo that fails one is not written,
 * the build exits non-zero, and this file keeps its previous contents.
 *
 * Rebuild with:  node tools/build-demos.mjs
 */
import type { DemoManifest } from './types'

export const DEMO_MANIFEST: DemoManifest = {
  "schemaVersion": 1,
  "catalogVersion": "2026-07",
  "generatedBy": "tools/build-demos.mjs",
  "authoredAt": "2026-07-01T00:00:00.000Z",
  "gates": [
    "catalog membership and compiled geometry for every part",
    "triangle-confirmed collision, twice, with no unverified verdicts",
    "one connected component over the derived connection graph",
    "derived build order re-verified against its own guarantee",
    "measured statics: full mass coverage, load path reaches every part, centre of mass inside the support polygon",
    "a measurably worse first candidate, so the refinement shown is real"
  ],
  "demos": [
    {
      "id": "illinois-main-quad",
      "title": "Illinois Main Quad campus",
      "discipline": "Campus architecture",
      "tagline": "A 120 × 80-stud university campus with seven landmarks, a tiled quad, trees, Morrow Plots and 21 LEGO characters.",
      "summary": "A display-scale UIUC campus set anchored by the Illini Union and Foellinger Auditorium, with Altgeld Hall, Alma Mater, six flanking academic blocks, the Main Quad path geometry, Morrow Plots, mature trees and brick-built students. The site finish alone is 9,600 individually editable pieces over a cross-bonded base.",
      "techniques": [
        "10,000+ catalog-backed pieces",
        "Cross-bonded 120 × 80-stud foundation",
        "Seven named campus landmarks",
        "Stepped copper dome and bell tower",
        "18 campus figures",
        "Three-figure Alma Mater group"
      ],
      "showcase": {
        "landmarkCount": 7,
        "characterCount": 21,
        "siteFinishParts": 9600
      },
      "refinement": "The massing study established the Main Quad axis on a one-layer field, but its plate runs were disconnected. The published set cross-bonds the entire site, replaces the massing blocks with detailed landmark buildings, and adds the 9,600-piece landscape, characters and buildable campus life.",
      "hero": true,
      "tensionAllowance": 256,
      "tensionReason": "Window panes are seated inside their frames rather than carried in vertical compression. The statics pass counts those glazed inserts as tension-carried, measures their mass, and still checks every attachment group against the conservative clutch assumption.",
      "brief": {
        "prompt": "Build a display-scale replica of the University of Illinois Main Quad with the Union and Foellinger on axis, Altgeld and Alma Mater, academic halls, Morrow Plots, trees, paths, and enough students to make it feel alive. It must exceed ten thousand real pieces and still pass the physical kernel.",
        "envelopeStuds": [
          120,
          null,
          80
        ],
        "palette": [
          "Illinois orange and blue",
          "Campus red brick",
          "Copper green",
          "Quad green",
          "Limestone white"
        ],
        "functions": [
          "10,000+ editable pieces",
          "Recognisable campus landmarks",
          "LEGO characters",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 34,
        "pitch": 54,
        "zoom": 0.96
      },
      "documentId": "demo_illinois_main_quad",
      "roughDocumentId": "demo_illinois_main_quad_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/illinois-main-quad/document.json",
          "bytes": 12537504,
          "sha256": "1ef6175469b97ed3acfc8d685895c888b463c32f49cc709f3c9f6433ece06337",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/illinois-main-quad/rough.json",
          "bytes": 464465,
          "sha256": "cdb1e303750bb3f8846291be5a0f2cda6fdadb7e8ddabb158bf5e76c6eb74881",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/illinois-main-quad/preview.json",
          "bytes": 614243,
          "sha256": "ba73cba7acd2e084f80f6e48a4a50ca011edbec88cba1e4ebbb8c6c9b198502f",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/illinois-main-quad/rough-preview.json",
          "bytes": 37545,
          "sha256": "c7ecdcb991e7c1f67edce80f371843bab9bffd81d6315ecd3d3644f13676d2e0",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/illinois-main-quad/thumb.png",
          "bytes": 51537,
          "sha256": "708138ca19ab6e2fb91b5752148130a53f1c43ae2d86dafc5870efb530d58722",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/illinois-main-quad/social.png",
          "bytes": 97145,
          "sha256": "011529a7cfe0225004272175e7cf4022a18cde4f844600680d6d038f5632fbe6",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 11473,
        "connectionCount": 26496,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 63,
        "weakAttachmentCount": 9069,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -356,
            0
          ],
          "max": [
            2400,
            0,
            1600
          ],
          "size": [
            2400,
            356,
            1600
          ]
        },
        "footprintStuds": [
          120,
          80
        ],
        "heightPlates": 44.5,
        "steps": 185,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 7884.3,
          "massLabel": "7.88 kg",
          "measuredParts": 11473,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "120.0 × 80.0 studs",
          "tippingMarginLdu": 783.71,
          "restingParts": 654,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 56,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 422,
        "connectionCount": 916,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 206,
        "disconnectedPartCount": 350,
        "virtualColorCount": 34,
        "weakAttachmentCount": 85,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -84,
            0
          ],
          "max": [
            2400,
            0,
            1600
          ],
          "size": [
            2400,
            84,
            1600
          ]
        },
        "footprintStuds": [
          120,
          80
        ],
        "heightPlates": 10.5,
        "steps": 214,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "205 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "202 parts have no connection at all and cannot be attached in any step."
        ],
        "statics": {
          "massGrams": 2045.96,
          "massLabel": "2.05 kg",
          "measuredParts": 422,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "120.0 × 80.0 studs",
          "tippingMarginLdu": 786.81,
          "restingParts": 368,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 11051,
        "connectionsAdded": 25580,
        "componentsBefore": 206,
        "componentsAfter": 1,
        "loosePartsBefore": 350,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 56,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 2045.96,
        "massAfterGrams": 7884.3,
        "stepsBefore": 214,
        "stepsAfter": 185
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 7996
        },
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 1607
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 542
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 190
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 114
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 113
        },
        {
          "definitionId": "3622",
          "name": "Brick 1 x 3",
          "count": 106
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 90
        },
        {
          "definitionId": "91988",
          "name": "Plate 2 x 14",
          "count": 79
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 64
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 62
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 60
        }
      ],
      "distinctParts": 35,
      "planWarnings": [],
      "provenance": {
        "generator": "tools/build-demos.mjs",
        "kernel": "src/cad — validation, collision, instructions, statics, snapping, assembly, raster",
        "catalogVersion": "2026-07",
        "catalogManifestGeneratedAt": "2026-08-27T23:25:07.690Z",
        "catalogPartsHash": "sha256:4f2a281c35d129addc81554fe6d690da61eccc0d4e77a5b9ef8eccfe6e71b6fb",
        "renderer": "src/cad/raster.ts — offline software rasterizer, no browser",
        "authoredAt": "2026-07-01T00:00:00.000Z"
      }
    },
    {
      "id": "courtyard-terrace",
      "title": "Courtyard terrace",
      "discipline": "Architecture",
      "tagline": "A bonded storey, seated windows and a parapet roof, from four parametric calls.",
      "summary": "Every course is offset against the one below, the corners alternate which run goes full length, and each opening holds a real compiled window or door frame chosen by measured footprint.",
      "techniques": [
        "Running bond",
        "Interlocking corners",
        "Seated window and door frames",
        "Cross-bonded slab"
      ],
      "showcase": null,
      "refinement": "The first candidate laid a single-layer deck and cut bare holes where the openings are. Plates side by side in one plane do not clutch, so the deck came apart into loose strips.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": {
        "prompt": "A terrace block twenty studs by fourteen, six courses high, in tan, with two windows and a door across the front, and a roof you could stand a figure on.",
        "envelopeStuds": [
          20,
          null,
          14
        ],
        "palette": [
          "Tan",
          "White",
          "Dark Bluish Grey",
          "Dark Tan"
        ],
        "functions": [
          "Bonded courses",
          "Seated frames",
          "Walkable roof"
        ]
      },
      "camera": {
        "yaw": 38,
        "pitch": 26,
        "zoom": 1
      },
      "documentId": "demo_courtyard_terrace",
      "roughDocumentId": "demo_courtyard_terrace_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/courtyard-terrace/document.json",
          "bytes": 421679,
          "sha256": "e81accffcce0f6fec77a33ab9f6a2884c247a725d9fc92e3cb46b67a788f9543",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/courtyard-terrace/rough.json",
          "bytes": 145189,
          "sha256": "27a49d710ac05f75e9681f40e129a3477f5b1fa58d7a8b8fa5ab0649284a12af",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/courtyard-terrace/preview.json",
          "bytes": 10980,
          "sha256": "07d869c166856512b8c40a450cffb9cc945f486d315d411b16fd51551e57e350",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/courtyard-terrace/rough-preview.json",
          "bytes": 6464,
          "sha256": "b2c286ee2ac899a5c6ed7ca040282ef0ded68a71d940e5427b73ef077afbf39b",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/courtyard-terrace/thumb.png",
          "bytes": 19122,
          "sha256": "c868d0879b5d2dd38140f94931b2078ce9fcc3b7ac83fb880cbf4f1cdd49c592",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/courtyard-terrace/social.png",
          "bytes": 34112,
          "sha256": "bca0a5448fdc4d69736485517f23a27b46362bc05e2cf68ab2af43d11b52bb08",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 142,
        "connectionCount": 1016,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 2,
        "weakAttachmentCount": 0,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -204,
            0
          ],
          "max": [
            400,
            0,
            280
          ],
          "size": [
            400,
            204,
            280
          ]
        },
        "footprintStuds": [
          20,
          14
        ],
        "heightPlates": 25.5,
        "steps": 13,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 373.94,
          "massLabel": "374 g",
          "measuredParts": 142,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "20.0 × 14.0 studs",
          "tippingMarginLdu": 139.93,
          "restingParts": 32,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 78,
        "connectionCount": 304,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 2,
        "disconnectedPartCount": 39,
        "virtualColorCount": 0,
        "weakAttachmentCount": 16,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -156,
            0
          ],
          "max": [
            400,
            0,
            280
          ],
          "size": [
            400,
            156,
            280
          ]
        },
        "footprintStuds": [
          20,
          14
        ],
        "heightPlates": 19.5,
        "steps": 8,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "1 part begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 184.81,
          "massLabel": "185 g",
          "measuredParts": 78,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "20.0 × 14.0 studs",
          "tippingMarginLdu": 139.89,
          "restingParts": 22,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 64,
        "connectionsAdded": 712,
        "componentsBefore": 2,
        "componentsAfter": 1,
        "loosePartsBefore": 39,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 184.81,
        "massAfterGrams": 373.94,
        "stepsBefore": 8,
        "stepsAfter": 13
      },
      "bill": [
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 24
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 24
        },
        {
          "definitionId": "2445",
          "name": "Plate 2 x 12",
          "count": 14
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 14
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 14
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 10
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 8
        },
        {
          "definitionId": "3622",
          "name": "Brick 1 x 3",
          "count": 8
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 6
        },
        {
          "definitionId": "3023b",
          "name": "Plate 1 x 2",
          "count": 4
        },
        {
          "definitionId": "3666",
          "name": "Plate 1 x 6",
          "count": 4
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 4
        }
      ],
      "distinctParts": 15,
      "planWarnings": [],
      "provenance": {
        "generator": "tools/build-demos.mjs",
        "kernel": "src/cad — validation, collision, instructions, statics, snapping, assembly, raster",
        "catalogVersion": "2026-07",
        "catalogManifestGeneratedAt": "2026-08-27T23:25:07.690Z",
        "catalogPartsHash": "sha256:4f2a281c35d129addc81554fe6d690da61eccc0d4e77a5b9ef8eccfe6e71b6fb",
        "renderer": "src/cad/raster.ts — offline software rasterizer, no browser",
        "authoredAt": "2026-07-01T00:00:00.000Z"
      }
    },
    {
      "id": "ridgeline-hauler",
      "title": "Ridgeline hauler",
      "discipline": "Vehicle",
      "tagline": "A flatbed on two real wheel bricks, with a closed cab and a tiled deck.",
      "summary": "The chassis is two plate layers whose seams deliberately miss each other, so the hauler is one rigid body rather than two halves that happen to touch.",
      "techniques": [
        "Interlocked chassis",
        "Wheel bricks as running gear",
        "Tiled load bed"
      ],
      "showcase": null,
      "refinement": "The first candidate locked the chassis with two 4 x 4 plates that left the centreline seam unbridged, so the front and rear halves were separate components.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": null,
      "camera": {
        "yaw": -34,
        "pitch": 22,
        "zoom": 1
      },
      "documentId": "demo_ridgeline_hauler",
      "roughDocumentId": "demo_ridgeline_hauler_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/ridgeline-hauler/document.json",
          "bytes": 60496,
          "sha256": "1467d298a0cc5abaa0dafdd6e8018e3b44d834351963d00ff62c9d75ffd05849",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/ridgeline-hauler/rough.json",
          "bytes": 48714,
          "sha256": "bee35d77419eecc67ebc54eed13507f7fcc280d11bda7f3a66585364c4259917",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/ridgeline-hauler/preview.json",
          "bytes": 4828,
          "sha256": "6c5ce1c0749baaf24cea88642abb565bb1d9ca80f053865f9a73fce9cc9529e0",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/ridgeline-hauler/rough-preview.json",
          "bytes": 4546,
          "sha256": "5575addfa68a213730ffee16712013faa0fb4514ce6af3a3d18d6d92dbf654df",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/ridgeline-hauler/thumb.png",
          "bytes": 11277,
          "sha256": "0323944320ae13b5d4e49e20f27b84fd8f6c3558978b0e9f98ecc41b91d0f4b6",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/ridgeline-hauler/social.png",
          "bytes": 17834,
          "sha256": "8d541283c01a03d5d128200987771e3e8793d678b41484930fda18d4bdb29b8c",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 33,
        "connectionCount": 136,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 0,
        "weakAttachmentCount": 11,
        "healthy": true,
        "boundsLdu": {
          "min": [
            -40,
            -104,
            -120
          ],
          "max": [
            40,
            8,
            120
          ],
          "size": [
            80,
            112,
            240
          ]
        },
        "footprintStuds": [
          4,
          12
        ],
        "heightPlates": 14,
        "steps": 7,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 45.2,
          "massLabel": "45 g",
          "measuredParts": 33,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "4.0 × 10.0 studs",
          "tippingMarginLdu": 40,
          "restingParts": 2,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 33,
        "connectionCount": 104,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 5,
        "disconnectedPartCount": 18,
        "virtualColorCount": 0,
        "weakAttachmentCount": 13,
        "healthy": true,
        "boundsLdu": {
          "min": [
            -40,
            -104,
            -120
          ],
          "max": [
            40,
            8,
            120
          ],
          "size": [
            80,
            112,
            240
          ]
        },
        "footprintStuds": [
          4,
          12
        ],
        "heightPlates": 14,
        "steps": 11,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "4 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "1 part have no connection at all and cannot be attached in any step."
        ],
        "statics": {
          "massGrams": 42.46,
          "massLabel": "42 g",
          "measuredParts": 33,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "4.0 × 10.0 studs",
          "tippingMarginLdu": 40,
          "restingParts": 2,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 7,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 0,
        "connectionsAdded": 32,
        "componentsBefore": 5,
        "componentsAfter": 1,
        "loosePartsBefore": 18,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 7,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 42.46,
        "massAfterGrams": 45.2,
        "stepsBefore": 11,
        "stepsAfter": 7
      },
      "bill": [
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 10
        },
        {
          "definitionId": "3069b",
          "name": "Tile 1 x 2 with Groove",
          "count": 6
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 4
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 3
        },
        {
          "definitionId": "3068b",
          "name": "Tile 2 x 2 with Groove",
          "count": 3
        },
        {
          "definitionId": "3031",
          "name": "Plate 4 x 4",
          "count": 2
        },
        {
          "definitionId": "3137c01",
          "name": "Brick Special 2 x 2 [Red Wheels for Single Tyre]",
          "count": 2
        },
        {
          "definitionId": "3035",
          "name": "Plate 4 x 8",
          "count": 1
        },
        {
          "definitionId": "3823",
          "name": "Windscreen 2 x 4 x 2",
          "count": 1
        },
        {
          "definitionId": "87079",
          "name": "Tile 2 x 4 with Groove",
          "count": 1
        }
      ],
      "distinctParts": 10,
      "planWarnings": [],
      "provenance": {
        "generator": "tools/build-demos.mjs",
        "kernel": "src/cad — validation, collision, instructions, statics, snapping, assembly, raster",
        "catalogVersion": "2026-07",
        "catalogManifestGeneratedAt": "2026-08-27T23:25:07.690Z",
        "catalogPartsHash": "sha256:4f2a281c35d129addc81554fe6d690da61eccc0d4e77a5b9ef8eccfe6e71b6fb",
        "renderer": "src/cad/raster.ts — offline software rasterizer, no browser",
        "authoredAt": "2026-07-01T00:00:00.000Z"
      }
    },
    {
      "id": "heron-sculpture",
      "title": "Heron",
      "discipline": "Creature",
      "tagline": "A standing bird whose stability is measured, not assumed.",
      "summary": "Slopes, round bricks and a cheese-slope beak, every one of them resting on a plane derived from its own compiled connectors rather than a nominal brick height.",
      "techniques": [
        "Round-brick legs",
        "Slope tail and wings",
        "Measured tipping margin"
      ],
      "showcase": null,
      "refinement": "The first candidate placed the head by coordinate in front of the body. It rendered perfectly and the load path from the ground never reached it.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": null,
      "camera": {
        "yaw": 24,
        "pitch": 14,
        "zoom": 1
      },
      "documentId": "demo_heron_sculpture",
      "roughDocumentId": "demo_heron_sculpture_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/heron-sculpture/document.json",
          "bytes": 49255,
          "sha256": "83242a1864695a89a9469150406330d582ec7e9fa486d0bbb9df511144a10783",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/heron-sculpture/rough.json",
          "bytes": 42789,
          "sha256": "90010c46ad223808e6e259986bcddbc3909b1f0ac75056b41c21d1d1a1c5178f",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/heron-sculpture/preview.json",
          "bytes": 4447,
          "sha256": "3aad63753d591a820499f193324ef61393e8ae28490784269782b428843c9a5e",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/heron-sculpture/rough-preview.json",
          "bytes": 3881,
          "sha256": "37555d93827890600c0bf388625a5e457cc58e2fd7cb1d3185315aaf3ee25f6d",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/heron-sculpture/thumb.png",
          "bytes": 10449,
          "sha256": "911aa7a4aaee3752c453d671ab9ec30b660d7db20ee07ec36d23de08a0bbf6f9",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/heron-sculpture/social.png",
          "bytes": 17513,
          "sha256": "7cecd710c2505843bbcfe9b41d8e61f4bd6a2077efc80ad6b7b773e45dd4a303",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 32,
        "connectionCount": 108,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 0,
        "weakAttachmentCount": 10,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -231.6,
            0
          ],
          "max": [
            160,
            0,
            160
          ],
          "size": [
            160,
            231.6,
            160
          ]
        },
        "footprintStuds": [
          8,
          8
        ],
        "heightPlates": 28.95,
        "steps": 7,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 39.5,
          "massLabel": "39 g",
          "measuredParts": 32,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "8.0 × 8.0 studs",
          "tippingMarginLdu": 73.53,
          "restingParts": 11,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 26,
        "connectionCount": 96,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 2,
        "disconnectedPartCount": 2,
        "virtualColorCount": 0,
        "weakAttachmentCount": 9,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -220,
            0
          ],
          "max": [
            160,
            0,
            160
          ],
          "size": [
            160,
            220,
            160
          ]
        },
        "footprintStuds": [
          8,
          8
        ],
        "heightPlates": 27.5,
        "steps": 6,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "1 part begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 36.08,
          "massLabel": "36 g",
          "measuredParts": 26,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "8.0 × 8.0 studs",
          "tippingMarginLdu": 77.85,
          "restingParts": 11,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 2,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 6,
        "connectionsAdded": 12,
        "componentsBefore": 2,
        "componentsAfter": 1,
        "loosePartsBefore": 2,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 2,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 36.08,
        "massAfterGrams": 39.5,
        "stepsBefore": 6,
        "stepsAfter": 7
      },
      "bill": [
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 8
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 6
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 4
        },
        {
          "definitionId": "3003",
          "name": "Brick 2 x 2",
          "count": 3
        },
        {
          "definitionId": "3023b",
          "name": "Plate 1 x 2",
          "count": 2
        },
        {
          "definitionId": "3040b",
          "name": "Brick Sloped 45° 2 x 1 with Bottom Pin",
          "count": 2
        },
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 2
        },
        {
          "definitionId": "3666",
          "name": "Plate 1 x 6",
          "count": 2
        },
        {
          "definitionId": "85984",
          "name": "Brick Sloped 30° 1 x 2 x 2/3",
          "count": 2
        },
        {
          "definitionId": "3020",
          "name": "Plate 2 x 4",
          "count": 1
        }
      ],
      "distinctParts": 10,
      "planWarnings": [],
      "provenance": {
        "generator": "tools/build-demos.mjs",
        "kernel": "src/cad — validation, collision, instructions, statics, snapping, assembly, raster",
        "catalogVersion": "2026-07",
        "catalogManifestGeneratedAt": "2026-08-27T23:25:07.690Z",
        "catalogPartsHash": "sha256:4f2a281c35d129addc81554fe6d690da61eccc0d4e77a5b9ef8eccfe6e71b6fb",
        "renderer": "src/cad/raster.ts — offline software rasterizer, no browser",
        "authoredAt": "2026-07-01T00:00:00.000Z"
      }
    },
    {
      "id": "shutter-bay",
      "title": "Shutter bay",
      "discipline": "Mechanism",
      "tagline": "A hinge the connection graph reads as a real revolute joint.",
      "summary": "The shutter is a hinge-brick pair and a plate flap. The kernel records the joint with its freedom, so the same model can be opened from the inspector or by an agent.",
      "techniques": [
        "Hinge-brick pair",
        "Revolute joint in the graph",
        "Seated window"
      ],
      "showcase": null,
      "refinement": "The first candidate laid the shutter as free plates one course above the deck — a slab held by nothing, which the load-path walk never reaches.",
      "hero": false,
      "tensionAllowance": 5,
      "tensionReason": "The hinge top plates and the flap they carry hang from the hinge rather than resting on it, which is what a hinge is. The statics pass reports them as carried in tension and checks that the clutch assumption covers their mass.",
      "brief": null,
      "camera": {
        "yaw": -22,
        "pitch": 30,
        "zoom": 1
      },
      "documentId": "demo_shutter_bay",
      "roughDocumentId": "demo_shutter_bay_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/shutter-bay/document.json",
          "bytes": 116468,
          "sha256": "571747e26a05219938002f321e038ed400fdcffe145244c04c9ea722346f8ff6",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/shutter-bay/rough.json",
          "bytes": 86541,
          "sha256": "adfbc41be3b0aec3980075208c33958d11c98c94a799e7bbd881dd10dfb82463",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/shutter-bay/preview.json",
          "bytes": 6637,
          "sha256": "ef4c73a588f89301b41dd3d6d80779f2141a88a257edd50af88fd50105e67b0c",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/shutter-bay/rough-preview.json",
          "bytes": 5261,
          "sha256": "1d800af468460f2884079e895e6c3b72c13fda09bb6919870808fd7ae52efd02",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/shutter-bay/thumb.png",
          "bytes": 16000,
          "sha256": "7d8d71b960ad7209c69139f6c201bccdbffec8b8185ce10810943487dd119558",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/shutter-bay/social.png",
          "bytes": 25858,
          "sha256": "00e7cc456d204ea44a7658410f10b06206eda6bd82aacda4d688229ea39eb304",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 56,
        "connectionCount": 270,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 4,
        "weakAttachmentCount": 0,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -140,
            0
          ],
          "max": [
            280,
            0,
            200
          ],
          "size": [
            280,
            140,
            200
          ]
        },
        "footprintStuds": [
          14,
          10
        ],
        "heightPlates": 17.5,
        "steps": 9,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 90.92,
          "massLabel": "91 g",
          "measuredParts": 56,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "14.0 × 10.0 studs",
          "tippingMarginLdu": 78.52,
          "restingParts": 22,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 5,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 41,
        "connectionCount": 202,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 3,
        "disconnectedPartCount": 2,
        "virtualColorCount": 0,
        "weakAttachmentCount": 1,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -140,
            0
          ],
          "max": [
            280,
            0,
            200
          ],
          "size": [
            280,
            140,
            200
          ]
        },
        "footprintStuds": [
          14,
          10
        ],
        "heightPlates": 17.5,
        "steps": 8,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "2 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "2 parts have no connection at all and cannot be attached in any step."
        ],
        "statics": {
          "massGrams": 83.42,
          "massLabel": "83 g",
          "measuredParts": 41,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "14.0 × 10.0 studs",
          "tippingMarginLdu": 72.86,
          "restingParts": 22,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 2,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 15,
        "connectionsAdded": 68,
        "componentsBefore": 3,
        "componentsAfter": 1,
        "loosePartsBefore": 2,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 2,
        "unsupportedAfter": 5,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 83.42,
        "massAfterGrams": 90.92,
        "stepsBefore": 8,
        "stepsAfter": 9
      },
      "bill": [
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 6
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 5
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 4
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 4
        },
        {
          "definitionId": "3020",
          "name": "Plate 2 x 4",
          "count": 4
        },
        {
          "definitionId": "3068b",
          "name": "Tile 2 x 2 with Groove",
          "count": 4
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 4
        },
        {
          "definitionId": "3937",
          "name": "Hinge Brick 1 x 2 Base",
          "count": 4
        },
        {
          "definitionId": "3938",
          "name": "Hinge Brick 1 x 2 Top Plate Thin",
          "count": 4
        },
        {
          "definitionId": "87079",
          "name": "Tile 2 x 4 with Groove",
          "count": 4
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 2
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 2
        }
      ],
      "distinctParts": 17,
      "planWarnings": [],
      "provenance": {
        "generator": "tools/build-demos.mjs",
        "kernel": "src/cad — validation, collision, instructions, statics, snapping, assembly, raster",
        "catalogVersion": "2026-07",
        "catalogManifestGeneratedAt": "2026-08-27T23:25:07.690Z",
        "catalogPartsHash": "sha256:4f2a281c35d129addc81554fe6d690da61eccc0d4e77a5b9ef8eccfe6e71b6fb",
        "renderer": "src/cad/raster.ts — offline software rasterizer, no browser",
        "authoredAt": "2026-07-01T00:00:00.000Z"
      }
    },
    {
      "id": "draughting-desk",
      "title": "Draughting desk",
      "discipline": "Furniture",
      "tagline": "Four legs, a braced underframe and a top that is a slab rather than a sheet.",
      "summary": "Rails tie the legs at desk height so the top is carried at its edges, and both the shelf and the desktop are cross-bonded two-layer slabs.",
      "techniques": [
        "Cross-bonded slab",
        "Braced underframe",
        "Tiled work surface"
      ],
      "showcase": null,
      "refinement": "The first candidate laid the shelf and the desktop one plate deep. Single-layer plates in one plane do not clutch each other, so the middle of both surfaces was loose.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": null,
      "camera": {
        "yaw": 42,
        "pitch": 18,
        "zoom": 1
      },
      "documentId": "demo_draughting_desk",
      "roughDocumentId": "demo_draughting_desk_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/draughting-desk/document.json",
          "bytes": 79859,
          "sha256": "9f652188a87e01929bf53ee6c0fc1d7643338224fce0f272ae6832390a86f1ef",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/draughting-desk/rough.json",
          "bytes": 22038,
          "sha256": "2dacfa24359138cbea7fdd8808c1d51d04b62a12b27e74491f0fdf892a4aec80",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/draughting-desk/preview.json",
          "bytes": 4352,
          "sha256": "c53212e453854bd1b2c54342810c85b01af4a28d608cc5fa470908260b0c0f12",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/draughting-desk/rough-preview.json",
          "bytes": 3505,
          "sha256": "2ccda91db4a42f6d98378f62d9c1ed1d86f7872f81df3266e510765732dfe9f4",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/draughting-desk/thumb.png",
          "bytes": 8123,
          "sha256": "3d6491e53f882d43c9564a643aedf419ba8e2fba8cfbcb26e45aac885dd23657",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/draughting-desk/social.png",
          "bytes": 14135,
          "sha256": "ec603431ffb08a816da9c57d3f7fe550c4f4bd9948c6ae42133f2f9a03342a06",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 36,
        "connectionCount": 188,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 0,
        "weakAttachmentCount": 4,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -304,
            0
          ],
          "max": [
            240,
            0,
            80
          ],
          "size": [
            240,
            304,
            80
          ]
        },
        "footprintStuds": [
          12,
          4
        ],
        "heightPlates": 38,
        "steps": 7,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 81.58,
          "massLabel": "82 g",
          "measuredParts": 36,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "12.0 × 4.0 studs",
          "tippingMarginLdu": 40,
          "restingParts": 4,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 18,
        "connectionCount": 44,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 2,
        "disconnectedPartCount": 9,
        "virtualColorCount": 0,
        "weakAttachmentCount": 8,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -284,
            0
          ],
          "max": [
            240,
            0,
            80
          ],
          "size": [
            240,
            284,
            80
          ]
        },
        "footprintStuds": [
          12,
          4
        ],
        "heightPlates": 35.5,
        "steps": 14,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "1 part begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 56.45,
          "massLabel": "56 g",
          "measuredParts": 18,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "12.0 × 4.0 studs",
          "tippingMarginLdu": 40,
          "restingParts": 4,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 18,
        "connectionsAdded": 144,
        "componentsBefore": 2,
        "componentsAfter": 1,
        "loosePartsBefore": 9,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 56.45,
        "massAfterGrams": 81.58,
        "stepsBefore": 14,
        "stepsAfter": 7
      },
      "bill": [
        {
          "definitionId": "2454b",
          "name": "Brick 1 x 2 x 5 with Hollow Studs",
          "count": 8
        },
        {
          "definitionId": "3666",
          "name": "Plate 1 x 6",
          "count": 8
        },
        {
          "definitionId": "87079",
          "name": "Tile 2 x 4 with Groove",
          "count": 6
        },
        {
          "definitionId": "3020",
          "name": "Plate 2 x 4",
          "count": 4
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 4
        },
        {
          "definitionId": "3022",
          "name": "Plate 2 x 2",
          "count": 2
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 2
        },
        {
          "definitionId": "6112",
          "name": "Brick 1 x 12",
          "count": 2
        }
      ],
      "distinctParts": 8,
      "planWarnings": [],
      "provenance": {
        "generator": "tools/build-demos.mjs",
        "kernel": "src/cad — validation, collision, instructions, statics, snapping, assembly, raster",
        "catalogVersion": "2026-07",
        "catalogManifestGeneratedAt": "2026-08-27T23:25:07.690Z",
        "catalogPartsHash": "sha256:4f2a281c35d129addc81554fe6d690da61eccc0d4e77a5b9ef8eccfe6e71b6fb",
        "renderer": "src/cad/raster.ts — offline software rasterizer, no browser",
        "authoredAt": "2026-07-01T00:00:00.000Z"
      }
    },
    {
      "id": "snot-kiosk",
      "title": "SNOT kiosk",
      "discipline": "Advanced technique",
      "tagline": "Facade tiles placed on vertical studs by the 6-DOF connector solver.",
      "summary": "A course of studs-on-side bricks turns the front wall sideways, and every facing tile is posed by `bestSnapTransform` from the two connector frames — the same solver a drag in the editor uses.",
      "techniques": [
        "Studs not on top",
        "Solved connector frames",
        "Cross-bonded cap"
      ],
      "showcase": null,
      "refinement": "The first candidate stopped at the studs-on-side course: the sideways studs were exposed and the facade was never faced.",
      "hero": false,
      "tensionAllowance": 3,
      "tensionReason": "The facing tiles hang off vertical studs. That is what studs-not-on-top means, and it is the one case where clutch is genuinely in tension, so the statics pass measures the load against the clutch assumption instead of waving it through.",
      "brief": null,
      "camera": {
        "yaw": 12,
        "pitch": 20,
        "zoom": 1
      },
      "documentId": "demo_snot_kiosk",
      "roughDocumentId": "demo_snot_kiosk_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/snot-kiosk/document.json",
          "bytes": 102097,
          "sha256": "dadb1c19757b8a76ec66b28934380b13aa9b0d059a44cca66a90515f310d9f3e",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/snot-kiosk/rough.json",
          "bytes": 99978,
          "sha256": "055a22dd897e6dde0be0304a9aba2e478e63dae74e04851a6132b4f232a44134",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/snot-kiosk/preview.json",
          "bytes": 3258,
          "sha256": "9ed35c4de3dea19914235f175e52cb226f9c88abb6573558255d22c192700bad",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/snot-kiosk/rough-preview.json",
          "bytes": 3435,
          "sha256": "6332aad37e9150d43510ac47ad57fd9caf7a8567a3476b9736bfaa2a259fc3ff",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/snot-kiosk/thumb.png",
          "bytes": 9160,
          "sha256": "28d8185d2369242d08af5b991f901ac4d4a4297b4badc5bbb755266a487d0646",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/snot-kiosk/social.png",
          "bytes": 14884,
          "sha256": "3f4abae1f34f123a5623dbb8fe265887ac73718aef79acdbe654d0988a74ce83",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 32,
        "connectionCount": 258,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 0,
        "weakAttachmentCount": 5,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -132,
            -8
          ],
          "max": [
            120,
            0,
            120
          ],
          "size": [
            120,
            132,
            128
          ]
        },
        "footprintStuds": [
          6,
          6.4
        ],
        "heightPlates": 16.5,
        "steps": 5,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 75.16,
          "massLabel": "75 g",
          "measuredParts": 32,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "6.0 × 6.0 studs",
          "tippingMarginLdu": 59.02,
          "restingParts": 7,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 3,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 32,
        "connectionCount": 252,
        "collisionCount": 3,
        "unverifiedCollisions": 0,
        "componentCount": 4,
        "disconnectedPartCount": 3,
        "virtualColorCount": 0,
        "weakAttachmentCount": 2,
        "healthy": false,
        "boundsLdu": {
          "min": [
            0,
            -132,
            -16
          ],
          "max": [
            120,
            0,
            120
          ],
          "size": [
            120,
            132,
            136
          ]
        },
        "footprintStuds": [
          6,
          6.8
        ],
        "heightPlates": 16.5,
        "steps": 8,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "3 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "3 parts have no connection at all and cannot be attached in any step."
        ],
        "statics": {
          "massGrams": 75.16,
          "massLabel": "75 g",
          "measuredParts": 32,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "6.0 × 6.0 studs",
          "tippingMarginLdu": 59,
          "restingParts": 7,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 3,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 0,
        "connectionsAdded": 6,
        "componentsBefore": 4,
        "componentsAfter": 1,
        "loosePartsBefore": 3,
        "loosePartsAfter": 0,
        "collisionsBefore": 3,
        "collisionsAfter": 0,
        "unsupportedBefore": 3,
        "unsupportedAfter": 3,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 75.16,
        "massAfterGrams": 75.16,
        "stepsBefore": 8,
        "stepsAfter": 5
      },
      "bill": [
        {
          "definitionId": "2456",
          "name": "Brick 2 x 6",
          "count": 11
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 10
        },
        {
          "definitionId": "3666",
          "name": "Plate 1 x 6",
          "count": 4
        },
        {
          "definitionId": "11211",
          "name": "Brick Special 1 x 2 with 2 Studs on 1 Side",
          "count": 3
        },
        {
          "definitionId": "3069b",
          "name": "Tile 1 x 2 with Groove",
          "count": 3
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 1
        }
      ],
      "distinctParts": 6,
      "planWarnings": [],
      "provenance": {
        "generator": "tools/build-demos.mjs",
        "kernel": "src/cad — validation, collision, instructions, statics, snapping, assembly, raster",
        "catalogVersion": "2026-07",
        "catalogManifestGeneratedAt": "2026-08-27T23:25:07.690Z",
        "catalogPartsHash": "sha256:4f2a281c35d129addc81554fe6d690da61eccc0d4e77a5b9ef8eccfe6e71b6fb",
        "renderer": "src/cad/raster.ts — offline software rasterizer, no browser",
        "authoredAt": "2026-07-01T00:00:00.000Z"
      }
    }
  ]
}

export default DEMO_MANIFEST
