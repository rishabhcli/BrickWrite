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
      "id": "harbour-street",
      "title": "Harbour Street",
      "discipline": "Modular architecture",
      "tagline": "A terrace of five shopfronts on a tiled street, every building and every floor separable.",
      "summary": "Five shopfronts on a tiled street. Every building lifts out, every floor lifts off.",
      "techniques": [
        "One subassembly per storey, per unit",
        "Tiled carriageway, kerb and pavement",
        "Seated shopfront doors and glazing",
        "Parapet roofline"
      ],
      "showcase": null,
      "refinement": "The first candidate laid the terrace as one continuous shell on a painted ground plane, so nothing came apart and the street was a texture. The published set separates every unit and every floor, and lays the road surface as individual tiles.",
      "hero": false,
      "tensionAllowance": 480,
      "tensionReason": "Glazing is seated inside its frames and each storey deck rests on the walls below it at the perimeter rather than clutching down into them. The statics pass counts both as tension-carried; the allowance is bounded so a genuinely unsupported storey still fails.",
      "brief": {
        "prompt": "A street of five modular shops with flats above, on a tiled road with kerbs and pavement, where every building and every floor can be lifted off separately.",
        "envelopeStuds": [
          76,
          null,
          34
        ],
        "palette": [
          "Reddish Brown",
          "Sand",
          "Dark Tan",
          "White",
          "Tan"
        ],
        "functions": [
          "Separable units and storeys",
          "Glazed shopfronts",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 34,
        "pitch": 26,
        "zoom": 1.12
      },
      "documentId": "demo_harbour_street",
      "roughDocumentId": "demo_harbour_street_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/harbour-street/document.json",
          "bytes": 4842290,
          "sha256": "9f0d4dcc85ec4dcfcfd9f8ee38c991b3b2406063c8106e822418be4e0ca830d8",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/harbour-street/rough.json",
          "bytes": 1215617,
          "sha256": "1b804ded72d2992279fb9b7c1d310275e5581f41b0a5d749f55a3c3b890bdbfb",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/harbour-street/preview.json",
          "bytes": 166108,
          "sha256": "86836e87f4872c39a8e2fa80cc772c39b5d7bbfaa19552765f08c0225a56ee2f",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/harbour-street/rough-preview.json",
          "bytes": 60746,
          "sha256": "11df9ce5b90374152a2e83d422f1a0e8a7a87ec3713e33a961710a27c6e5ebcb",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/harbour-street/thumb.png",
          "bytes": 31706,
          "sha256": "368a026e75c0a01a4873d273b93f09ddf5d283c00a3bc5ea7a0c75e9f30fb5a7",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/harbour-street/social.png",
          "bytes": 54298,
          "sha256": "e7e9ea716b6e82fb0876ebcfa7f43b28d21521b9525392231b1ae5c9a4fba0af",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 3041,
        "connectionCount": 10882,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 24,
        "weakAttachmentCount": 1623,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -452,
            0
          ],
          "max": [
            1520,
            0,
            680
          ],
          "size": [
            1520,
            452,
            680
          ]
        },
        "footprintStuds": [
          76,
          34
        ],
        "heightPlates": 56.5,
        "steps": 45,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 3611.92,
          "massLabel": "3.61 kg",
          "measuredParts": 3041,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "76.0 × 34.0 studs",
          "tippingMarginLdu": 276.35,
          "restingParts": 213,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 70,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 1091,
        "connectionCount": 2496,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 34,
        "disconnectedPartCount": 673,
        "virtualColorCount": 5,
        "weakAttachmentCount": 712,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -308,
            0
          ],
          "max": [
            680,
            0,
            680
          ],
          "size": [
            680,
            308,
            680
          ]
        },
        "footprintStuds": [
          34,
          34
        ],
        "heightPlates": 38.5,
        "steps": 42,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "33 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 976.37,
          "massLabel": "976 g",
          "measuredParts": 1091,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "34.0 × 34.0 studs",
          "tippingMarginLdu": 278.66,
          "restingParts": 763,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 16,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 1950,
        "connectionsAdded": 8386,
        "componentsBefore": 34,
        "componentsAfter": 1,
        "loosePartsBefore": 673,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 16,
        "unsupportedAfter": 70,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 976.37,
        "massAfterGrams": 3611.92,
        "stepsBefore": 42,
        "stepsAfter": 45
      },
      "bill": [
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 1510
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 250
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 210
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 140
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 132
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 107
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 100
        },
        {
          "definitionId": "3020",
          "name": "Plate 2 x 4",
          "count": 92
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 91
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 90
        },
        {
          "definitionId": "60592",
          "name": "Window 1 x 2 x 2 Flat Front",
          "count": 70
        },
        {
          "definitionId": "60601",
          "name": "Glass for Window 1 x 2 x 2 Flat",
          "count": 70
        }
      ],
      "distinctParts": 23,
      "planWarnings": [
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole."
      ],
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
      "id": "meridian-tower",
      "title": "Meridian Tower",
      "discipline": "Modular architecture",
      "tagline": "A twenty-two-storey modular high-rise that lifts apart floor by floor, with real seated glazing.",
      "summary": "Twenty-two storeys, each its own subassembly. Every floor lifts off the one below it.",
      "techniques": [
        "One subassembly per storey",
        "Cross-bonded deck between floors",
        "Seated window frames on every elevation",
        "Stepped crown and mast"
      ],
      "showcase": null,
      "refinement": "The massing study stacked the storeys as one continuous shell, so there was no seam to lift and the facades were blank. The published set separates every floor onto its own two-layer deck and glazes the elevations with frames the catalogue actually compiles.",
      "hero": false,
      "tensionAllowance": 640,
      "tensionReason": "Two things in this model are held in bearing rather than in clutch, and the statics pass counts both as tension-carried. The glazing is seated inside its frames, and the middle of each storey deck rests on the walls below it at the perimeter rather than clutching down into them. Both are how a modular building is actually assembled; the allowance is bounded so a genuinely floating storey still fails the gate.",
      "brief": {
        "prompt": "A twenty-two-storey modular tower on a plaza, where every floor lifts off separately, the elevations carry real windows, and the crown steps back to a mast.",
        "envelopeStuds": [
          58,
          null,
          30
        ],
        "palette": [
          "Sand",
          "Tan",
          "White",
          "Light Bluish Grey",
          "Dark Bluish Grey"
        ],
        "functions": [
          "Separable storeys",
          "Glazed elevations",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 38,
        "pitch": 18,
        "zoom": 1.06
      },
      "documentId": "demo_meridian_tower",
      "roughDocumentId": "demo_meridian_tower_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/meridian-tower/document.json",
          "bytes": 11722582,
          "sha256": "5b0c7fc9d7d9de175cfc2a2092b6c0a0de7ddb3eb167cf917d5090585a001dd3",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/meridian-tower/rough.json",
          "bytes": 3232281,
          "sha256": "9f5063401d965fc125427dbfb9e819f7edd92520f3d31f73df8260897b04dbb3",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/meridian-tower/preview.json",
          "bytes": 264955,
          "sha256": "ac7e5ccf7df79df315d52c3ca8364a06aef0a75b233b4a1a9bd7e8f31de7032e",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/meridian-tower/rough-preview.json",
          "bytes": 115554,
          "sha256": "d64b7084efb6fb31c889d9bcddfb74f20e879004fa336c612d57461aabaea65b",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/meridian-tower/thumb.png",
          "bytes": 22583,
          "sha256": "3bd48b58ebb64934d2701b8798760151dce00e50fcf8ecf80135896cf0d41e86",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/meridian-tower/social.png",
          "bytes": 34763,
          "sha256": "cb597f2f1e29fd39175141ad49c24d395852864b6c8a72d22c2096d7db6d9b21",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 4767,
        "connectionCount": 28196,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 93,
        "weakAttachmentCount": 1587,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -3428,
            0
          ],
          "max": [
            1160,
            0,
            600
          ],
          "size": [
            1160,
            3428,
            600
          ]
        },
        "footprintStuds": [
          58,
          30
        ],
        "heightPlates": 428.5,
        "steps": 68,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 9611.04,
          "massLabel": "9.61 kg",
          "measuredParts": 4767,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "58.0 × 30.0 studs",
          "tippingMarginLdu": 299.98,
          "restingParts": 143,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 411,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 2118,
        "connectionCount": 7268,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 53,
        "disconnectedPartCount": 1060,
        "virtualColorCount": 15,
        "weakAttachmentCount": 1335,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -972,
            0
          ],
          "max": [
            1160,
            0,
            600
          ],
          "size": [
            1160,
            972,
            600
          ]
        },
        "footprintStuds": [
          58,
          30
        ],
        "heightPlates": 121.5,
        "steps": 69,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "52 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "8 parts have no connection at all and cannot be attached in any step."
        ],
        "statics": {
          "massGrams": 2618.32,
          "massLabel": "2.62 kg",
          "measuredParts": 2118,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "58.0 × 30.0 studs",
          "tippingMarginLdu": 299.97,
          "restingParts": 1344,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 87,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 2649,
        "connectionsAdded": 20928,
        "componentsBefore": 53,
        "componentsAfter": 1,
        "loosePartsBefore": 1060,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 87,
        "unsupportedAfter": 411,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 2618.32,
        "massAfterGrams": 9611.04,
        "stepsBefore": 69,
        "stepsAfter": 68
      },
      "bill": [
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 1246
        },
        {
          "definitionId": "3622",
          "name": "Brick 1 x 3",
          "count": 644
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 483
        },
        {
          "definitionId": "60592",
          "name": "Window 1 x 2 x 2 Flat Front",
          "count": 318
        },
        {
          "definitionId": "60601",
          "name": "Glass for Window 1 x 2 x 2 Flat",
          "count": 318
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 298
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 282
        },
        {
          "definitionId": "3703",
          "name": "Technic Brick 1 x 16 [15 Pin Holes]",
          "count": 238
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 158
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 144
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 134
        },
        {
          "definitionId": "91988",
          "name": "Plate 2 x 14",
          "count": 115
        }
      ],
      "distinctParts": 24,
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
    }
  ]
}

export default DEMO_MANIFEST
