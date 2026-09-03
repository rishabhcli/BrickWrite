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
    "large-scale collection floor: at least 1,000 editable parts",
    "triangle-confirmed collision, twice, with no unverified verdicts",
    "one connected component over the derived connection graph",
    "derived build order re-verified against its own guarantee",
    "measured statics: full mass coverage, load path reaches every part, centre of mass inside the support polygon",
    "a measurably worse first candidate, so the refinement shown is real"
  ],
  "demos": [
    {
      "id": "blue-whale-monument",
      "title": "Blue Whale Monument",
      "discipline": "Large animal sculpture",
      "category": "animals",
      "tagline": "A 132-stud blue whale with raised flukes, projecting pectoral fins and a pale belly, breaking a lit ocean promenade.",
      "summary": "A display-scale animal sculpted as a 3D solid: a hull swept from a half-ellipse cross-section whose girth changes station by station, so the body swells behind the head and tapers into the tail stock. The flukes corbel clear of the water, the pectoral fins project past the flanks, and a pale belly and white foam separate the animal from the fully editable ocean mosaic beneath it.",
      "techniques": [
        "3D voxel solid, not a height map",
        "Swept half-ellipse hull with varying girth",
        "Flukes corbelled clear of the water",
        "Projecting pectoral fins",
        "Pale belly, ventral pleats and foam line",
        "Editable ocean mosaic and lit promenade"
      ],
      "showcase": null,
      "refinement": "The first candidate put a simplified whale on a one-layer plate field whose parallel runs stayed disconnected, in the same blue as the sea around it. The published monument cross-bonds the complete ocean plinth and resolves the body, flukes, fins, belly and eye into an animal that reads at thumbnail size.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": {
        "prompt": "A large brick-built blue whale monument with a tapering body, flukes raised clear of the water, side fins, a pale belly and white foam, mounted over an editable ocean mosaic.",
        "envelopeStuds": [
          132,
          null,
          56
        ],
        "palette": [
          "Medium Blue",
          "Blue",
          "White",
          "Trans Light Blue"
        ],
        "functions": [
          "Large animal figure",
          "Editable water scene",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 32,
        "pitch": 34,
        "zoom": 1.04
      },
      "documentId": "demo_blue_whale_monument",
      "roughDocumentId": "demo_blue_whale_monument_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/blue-whale-monument/document.json",
          "bytes": 13281289,
          "sha256": "1a8958086c32c717539a3dd22adcae9f7d9f912ab5fa8d37c9eb82d168eb33a5",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/blue-whale-monument/rough.json",
          "bytes": 6555003,
          "sha256": "334b5f5887d259f5e42d6a32282ebbb23e893b2473c50fb279476ae68e4d8e8a",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/blue-whale-monument/preview.json",
          "bytes": 496066,
          "sha256": "b303bfa82e65fcc2eac17c7385e54479f0e22a4c922cc633cd3fba79266392a7",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/blue-whale-monument/rough-preview.json",
          "bytes": 257997,
          "sha256": "924ad998862a439c161b0ae26efb501fec26397a6324a8573956e41650a21d12",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/blue-whale-monument/thumb.png",
          "bytes": 57178,
          "sha256": "0f7a85ccf8b77b41249fbb4c06ef0e89b2ffc1717e3c5c1d3f7335687c8a3b3b",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/blue-whale-monument/social.png",
          "bytes": 115128,
          "sha256": "ed41a8e7bcaf6afac2d1e3cad5ac97f242466c82fcf1d6230776d0c0a37c9186",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 9563,
        "connectionCount": 28535,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 222,
        "weakAttachmentCount": 5579,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -388,
            0
          ],
          "max": [
            2640,
            0,
            1120
          ],
          "size": [
            2640,
            388,
            1120
          ]
        },
        "footprintStuds": [
          132,
          56
        ],
        "heightPlates": 48.5,
        "steps": 103,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "Step 102 adds part_8476 into a pose already enclosed by part_8264, part_8276 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 102 adds part_8478 into a pose already enclosed by part_8365, part_8355 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 102 adds part_8502 into a pose already enclosed by part_8243, part_8496 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 102 adds part_8504 into a pose already enclosed by part_8345, part_8500 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 9243.71,
          "massLabel": "9.24 kg",
          "measuredParts": 9563,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "132.0 × 56.0 studs",
          "tippingMarginLdu": 559.24,
          "restingParts": 519,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 4781,
        "connectionCount": 13530,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 70,
        "disconnectedPartCount": 1921,
        "virtualColorCount": 168,
        "weakAttachmentCount": 2195,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -308,
            0
          ],
          "max": [
            1680,
            0,
            840
          ],
          "size": [
            1680,
            308,
            840
          ]
        },
        "footprintStuds": [
          84,
          42
        ],
        "heightPlates": 38.5,
        "steps": 247,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "69 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "Step 44 adds part_4092 into a pose already enclosed by part_3920, part_3927 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 44 adds part_4094 into a pose already enclosed by part_3996, part_3990 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 44 adds part_4118 into a pose already enclosed by part_3907, part_4112 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 44 adds part_4120 into a pose already enclosed by part_3983, part_4116 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 5086.47,
          "massLabel": "5.09 kg",
          "measuredParts": 4781,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "84.0 × 42.0 studs",
          "tippingMarginLdu": 320.68,
          "restingParts": 3654,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 4782,
        "connectionsAdded": 15005,
        "componentsBefore": 70,
        "componentsAfter": 1,
        "loosePartsBefore": 1921,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 5086.47,
        "massAfterGrams": 9243.71,
        "stepsBefore": 247,
        "stepsAfter": 103
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 7392
        },
        {
          "definitionId": "3007",
          "name": "Brick 2 x 8",
          "count": 461
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 424
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 385
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 148
        },
        {
          "definitionId": "2456",
          "name": "Brick 2 x 6",
          "count": 96
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 94
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 82
        },
        {
          "definitionId": "3001",
          "name": "Brick 2 x 4",
          "count": 75
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 74
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 73
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 54
        }
      ],
      "distinctParts": 23,
      "planWarnings": [
        "244 sculpted cell(s) had no course beneath them to clutch onto and were left out of Blue Whale Monument."
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
      "id": "sunline-suspension-bridge",
      "title": "Sunline Suspension Bridge",
      "discipline": "Landmark infrastructure",
      "category": "landmarks",
      "tagline": "Twin portal towers carry a 160-stud road deck and two stepped golden catenaries across a 168-stud river district.",
      "summary": "An original city landmark on a fully editable river. Masonry piers lift a bonded fourteen-stud road deck clear of the water, two portal towers straddle the carriageway so the road passes through them, and the suspension system is built the only way studs allow: hangers stand up off the deck and each stepped cable segment rests on the pair beneath it, so the catenary is drawn by parts that are every one of them on a load path to the bed.",
      "techniques": [
        "168 x 64-stud river district",
        "Twin portal towers with a through-road opening",
        "Nine-course masonry piers",
        "Bonded fourteen-stud road deck with kerbs and centre line",
        "Stepped catenary carried on standing hangers",
        "Back-stays landing on anchorage blocks"
      ],
      "showcase": null,
      "refinement": "The first candidate stopped at a one-layer river study, leaving its plate runs disconnected and no crossing between the banks. The published build cross-bonds the river, lifts a complete road deck onto piers, frames two portal towers over the carriageway and draws both catenaries.",
      "hero": false,
      "tensionAllowance": 320,
      "tensionReason": "The portal beams between each tower’s legs are seated on the legs at both ends rather than clutching down into them, and the bonded tower caps rest on the masonry beneath them. The statics pass counts both as tension-carried. The allowance is bounded so a floating deck, pier or cable segment still fails.",
      "brief": {
        "prompt": "An original large suspension bridge with twin portal towers the road passes through, a long raised deck, stepped golden catenaries carried on hangers, and a fully editable river beneath it.",
        "envelopeStuds": [
          168,
          null,
          64
        ],
        "palette": [
          "Dark Red",
          "Yellow",
          "Medium Blue",
          "Light Bluish Grey"
        ],
        "functions": [
          "Large landmark",
          "Editable river scene",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 28,
        "pitch": 22,
        "zoom": 1.02
      },
      "documentId": "demo_sunline_suspension_bridge",
      "roughDocumentId": "demo_sunline_suspension_bridge_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/sunline-suspension-bridge/document.json",
          "bytes": 19096696,
          "sha256": "5af02eaf279605fe911ff041c907a7987eb1ec77465a428148db13806d075e3d",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/sunline-suspension-bridge/rough.json",
          "bytes": 755964,
          "sha256": "335310f58d619408d220087f3d93442375cea40becec0bce7a94eaa975ac3d24",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/sunline-suspension-bridge/preview.json",
          "bytes": 781992,
          "sha256": "89db85f5316fd007152ce9d568901a967bc8ac3f66eac11553a685c662993880",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/sunline-suspension-bridge/rough-preview.json",
          "bytes": 71345,
          "sha256": "ea98e02d6bf0eee0b6f579f7d814b713e9bcddba4c85b7ead211c4597dd1d1c6",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/sunline-suspension-bridge/thumb.png",
          "bytes": 58298,
          "sha256": "2d9f4958a3bca04a6d13be6b95d3f2949cec8378c95a1f7fb5e68f2f34ecfba4",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/sunline-suspension-bridge/social.png",
          "bytes": 98680,
          "sha256": "44ff634c4ed7210ece7294109b462ba7706a4bb6e77d7af394ababacba005c9a",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 14714,
        "connectionCount": 41778,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 36,
        "weakAttachmentCount": 11210,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -932,
            0
          ],
          "max": [
            3360,
            0,
            1280
          ],
          "size": [
            3360,
            932,
            1280
          ]
        },
        "footprintStuds": [
          168,
          64
        ],
        "heightPlates": 116.5,
        "steps": 158,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 13621.48,
          "massLabel": "13.62 kg",
          "measuredParts": 14714,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "168.0 × 64.0 studs",
          "tippingMarginLdu": 639.99,
          "restingParts": 723,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 171,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 1276,
        "connectionCount": 1232,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 44,
        "disconnectedPartCount": 1243,
        "virtualColorCount": 0,
        "weakAttachmentCount": 1232,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -20,
            0
          ],
          "max": [
            1120,
            0,
            440
          ],
          "size": [
            1120,
            20,
            440
          ]
        },
        "footprintStuds": [
          56,
          22
        ],
        "heightPlates": 2.5,
        "steps": 131,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "43 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 469.8,
          "massLabel": "470 g",
          "measuredParts": 1276,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "56.0 × 22.0 studs",
          "tippingMarginLdu": 220,
          "restingParts": 1276,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 13438,
        "connectionsAdded": 40546,
        "componentsBefore": 44,
        "componentsAfter": 1,
        "loosePartsBefore": 1243,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 171,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 469.8,
        "massAfterGrams": 13621.48,
        "stepsBefore": 131,
        "stepsAfter": 158
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 9560
        },
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 1320
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 911
        },
        {
          "definitionId": "2456",
          "name": "Brick 2 x 6",
          "count": 844
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 599
        },
        {
          "definitionId": "3001",
          "name": "Brick 2 x 4",
          "count": 386
        },
        {
          "definitionId": "3006",
          "name": "Brick 2 x 10",
          "count": 196
        },
        {
          "definitionId": "3003",
          "name": "Brick 2 x 2",
          "count": 180
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 164
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 122
        },
        {
          "definitionId": "3007",
          "name": "Brick 2 x 8",
          "count": 100
        },
        {
          "definitionId": "3622",
          "name": "Brick 1 x 3",
          "count": 55
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
      "id": "copper-mammoth",
      "title": "Copper Canyon Mammoth",
      "discipline": "Large animal sculpture",
      "category": "animals",
      "tagline": "A 112-stud woolly mammoth standing on four legs, trunk down to the canyon floor and white tusks sweeping forward.",
      "summary": "A large animal figure sculpted as a 3D solid over a copper-and-sand canyon floor. It stands on four separate legs with daylight under the belly, the haunches corbel out of those legs course by course until they close over the middle, the trunk is built from the floor up because it reaches the ground, and the tusks root inside the head before they corbel forward. Body, legs, trunk, ears and tusks stay separate editable regions of one physically connected model.",
      "techniques": [
        "3D voxel solid, not a height map",
        "Four legs with an open belly",
        "Haunches corbelled out of the legs",
        "Trunk carried from the canyon floor",
        "Tusks rooted in the head, corbelled forward",
        "Editable canyon mosaic with strata banding"
      ],
      "showcase": null,
      "refinement": "The first candidate used a smaller height-mapped silhouette over loose plate runs — a brown mound with no legs, trunk or tusks. The published figure cross-bonds a 112-stud canyon and resolves the mammoth into a standing body, four grounded legs, ears, a lowered trunk and paired tusks.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": {
        "prompt": "A large brick-built woolly mammoth standing on four legs with an open belly, a lowered trunk reaching the ground, amber ears and white tusks, on a canyon display plinth.",
        "envelopeStuds": [
          112,
          null,
          64
        ],
        "palette": [
          "Reddish Brown",
          "Orange",
          "White",
          "Sand"
        ],
        "functions": [
          "Large animal figure",
          "Editable scenic base",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 36,
        "pitch": 30,
        "zoom": 1.06
      },
      "documentId": "demo_copper_mammoth",
      "roughDocumentId": "demo_copper_mammoth_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/copper-mammoth/document.json",
          "bytes": 19178478,
          "sha256": "229faa5b38e3c6bcf59cbf1a6f438f9a19219d11dcb95999b7e87825f79a1a52",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/copper-mammoth/rough.json",
          "bytes": 4953940,
          "sha256": "36f1e726972e2bc7db84bdf068c38511fc3709485b64bbbbe3962ab12f838fb6",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/copper-mammoth/preview.json",
          "bytes": 748790,
          "sha256": "4ea40cc9d5a8456396f908423ab3041566b597245fceafc6fdd2c9b74d469277",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/copper-mammoth/rough-preview.json",
          "bytes": 235978,
          "sha256": "c52f0c386974aaafea32357564149433caec875560d1189b476ad857eab56824",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/copper-mammoth/thumb.png",
          "bytes": 59177,
          "sha256": "6dbec77a9fb697d107c179d670cd416fbb130a6c81d41b9088edc5f57d946f28",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/copper-mammoth/social.png",
          "bytes": 97134,
          "sha256": "7d4e0de37ff71a1a883c3a54fbc6564add46a0c6a06e08f42aa59f7e3c1f5030",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 14006,
        "connectionCount": 40037,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 15,
        "weakAttachmentCount": 7132,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -892,
            0
          ],
          "max": [
            2240,
            0,
            1280
          ],
          "size": [
            2240,
            892,
            1280
          ]
        },
        "footprintStuds": [
          112,
          64
        ],
        "heightPlates": 111.5,
        "steps": 150,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "Step 148 adds part_9259 into a pose already enclosed by part_9248, part_9676 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 148 adds part_9158 into a pose already enclosed by part_9130, part_9675 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 14508.63,
          "massLabel": "14.51 kg",
          "measuredParts": 14006,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "112.0 × 64.0 studs",
          "tippingMarginLdu": 638.89,
          "restingParts": 524,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 4287,
        "connectionCount": 9797,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 88,
        "disconnectedPartCount": 3320,
        "virtualColorCount": 0,
        "weakAttachmentCount": 2841,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -500,
            0
          ],
          "max": [
            1360,
            0,
            880
          ],
          "size": [
            1360,
            500,
            880
          ]
        },
        "footprintStuds": [
          68,
          44
        ],
        "heightPlates": 62.5,
        "steps": 286,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "87 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "Step 8 adds part_3350 into a pose already enclosed by part_3337, part_3387 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_3353 into a pose already enclosed by part_3387, part_3337 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_3388 into a pose already enclosed by part_3349, part_3387 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_3391 into a pose already enclosed by part_3387, part_3349 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_3404 into a pose already enclosed by part_3441, part_3387 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_3407 into a pose already enclosed by part_3441, part_3387 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_3442 into a pose already enclosed by part_3457, part_3441 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_3445 into a pose already enclosed by part_3441, part_3457 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_3458 into a pose already enclosed by part_3441, part_3495 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_3461 into a pose already enclosed by part_3441, part_3495 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3309 into a pose already enclosed by part_3285, part_3335 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3312 into a pose already enclosed by part_3281, part_3285 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3336 into a pose already enclosed by part_3362, part_3335 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3339 into a pose already enclosed by part_3335, part_3362 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3363 into a pose already enclosed by part_3389, part_3335 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3366 into a pose already enclosed by part_3389, part_3335 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3390 into a pose already enclosed by part_3362, part_3389 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3393 into a pose already enclosed by part_3389, part_3362 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3417 into a pose already enclosed by part_3443, part_3389 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3420 into a pose already enclosed by part_3443, part_3389 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3444 into a pose already enclosed by part_3470, part_3443 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3447 into a pose already enclosed by part_3443, part_3470 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3471 into a pose already enclosed by part_3443, part_3497 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 22 adds part_3474 into a pose already enclosed by part_3443, part_3497 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 3805.9,
          "massLabel": "3.81 kg",
          "measuredParts": 4287,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "68.0 × 44.0 studs",
          "tippingMarginLdu": 305.09,
          "restingParts": 3102,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 9719,
        "connectionsAdded": 30240,
        "componentsBefore": 88,
        "componentsAfter": 1,
        "loosePartsBefore": 3320,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 3805.9,
        "massAfterGrams": 14508.63,
        "stepsBefore": 286,
        "stepsAfter": 150
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 7168
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 2010
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 1188
        },
        {
          "definitionId": "3002",
          "name": "Brick 2 x 3",
          "count": 853
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 564
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 504
        },
        {
          "definitionId": "3007",
          "name": "Brick 2 x 8",
          "count": 416
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 378
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 237
        },
        {
          "definitionId": "3001",
          "name": "Brick 2 x 4",
          "count": 163
        },
        {
          "definitionId": "3622",
          "name": "Brick 1 x 3",
          "count": 99
        },
        {
          "definitionId": "2456",
          "name": "Brick 2 x 6",
          "count": 83
        }
      ],
      "distinctParts": 24,
      "planWarnings": [
        "4531 sculpted cell(s) had no course beneath them to clutch onto and were left out of Copper Canyon Mammoth."
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
      "id": "colossal-duck",
      "title": "Colossal Duck Float",
      "discipline": "Playful public art",
      "category": "creative",
      "tagline": "A ninety-six-stud rubber duck: domed body, tall neck, cantilevered orange bill and a wake of lit moorings.",
      "summary": "A deliberately ridiculous public-art build at landmark scale. The duck is a 3D voxel solid rather than a height map, so the body domes out over its own waterline, the neck rises narrower than the body beneath it, and the orange bill cantilevers forward past the head on bricks that reach back into it. Every course is laid as cross-bonded brickwork over a rippling, fully editable festival basin.",
      "techniques": [
        "3D voxel solid, not a height map",
        "Cross-bonded courses in eleven brick footprints",
        "Overhanging domed body",
        "Cantilevered bill anchored into the head",
        "Editable rippled festival basin",
        "Festival lighting and shoreline planting"
      ],
      "showcase": null,
      "refinement": "The first float was a small yellow mass on loose one-layer water: its plate runs never bonded to each other and the silhouette had no neck, bill or eye. The published version cross-bonds the whole basin and resolves the body, neck, head, bill and eyes into a duck that reads at thumbnail size.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": {
        "prompt": "A funny large-scale yellow duck public-art float with a huge rounded body, tall neck, an orange bill that juts forward and black eyes, on an editable blue festival basin.",
        "envelopeStuds": [
          96,
          null,
          68
        ],
        "palette": [
          "Yellow",
          "Orange",
          "Black",
          "Trans Light Blue"
        ],
        "functions": [
          "Funny creative landmark",
          "Editable scenic base",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 34,
        "pitch": 38,
        "zoom": 1.04
      },
      "documentId": "demo_colossal_duck",
      "roughDocumentId": "demo_colossal_duck_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/colossal-duck/document.json",
          "bytes": 16386903,
          "sha256": "ea5e1478f83a98ad58e00d57463a050761fd8273e8abb35df3f59a042df288a7",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/colossal-duck/rough.json",
          "bytes": 10071910,
          "sha256": "16780dce5f3e46d5d9618e2b9da5c26db313e39a62f32df8b72a6e6aa3596bfe",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/colossal-duck/preview.json",
          "bytes": 481119,
          "sha256": "b128bee3b537338f0df31826043d8b645196fbd6486c87718f2713408fecd5cc",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/colossal-duck/rough-preview.json",
          "bytes": 256298,
          "sha256": "b86012247eb481b4eac922b5e1a61c0180682a6a22f653c8d1cc7593fed8e4f0",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/colossal-duck/thumb.png",
          "bytes": 47206,
          "sha256": "405fd046250693218950bda2f97a4811021f03b3ce61d71e734a7c9c4bbd8c80",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/colossal-duck/social.png",
          "bytes": 80080,
          "sha256": "e0c491d6d3b68128611a9960f055298bfe679b94530320ef6307ad71affc7afc",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 9271,
        "connectionCount": 35814,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 12,
        "weakAttachmentCount": 4951,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -892,
            0
          ],
          "max": [
            1920,
            0,
            1360
          ],
          "size": [
            1920,
            892,
            1360
          ]
        },
        "footprintStuds": [
          96,
          68
        ],
        "heightPlates": 111.5,
        "steps": 100,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "Step 99 adds part_9022 into a pose already enclosed by part_9009, part_9033 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 99 adds part_9019 into a pose already enclosed by part_9009, part_9033 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 99 adds part_9020 into a pose already enclosed by part_9009, part_9033 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 99 adds part_9021 into a pose already enclosed by part_9009, part_9033 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 99 adds part_9053 into a pose already enclosed by part_9077, part_9033 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 99 adds part_9051 into a pose already enclosed by part_9066, part_9033 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 99 adds part_9052 into a pose already enclosed by part_9066, part_9033 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 99 adds part_9060 into a pose already enclosed by part_9074, part_9072 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 99 adds part_9061 into a pose already enclosed by part_9074, part_9072 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 99 adds part_9062 into a pose already enclosed by part_9074, part_9072 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 11946.91,
          "massLabel": "11.95 kg",
          "measuredParts": 9271,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "96.0 × 68.0 studs",
          "tippingMarginLdu": 679.97,
          "restingParts": 487,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 4818,
        "connectionCount": 21767,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 57,
        "disconnectedPartCount": 1344,
        "virtualColorCount": 0,
        "weakAttachmentCount": 1594,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -500,
            0
          ],
          "max": [
            1280,
            0,
            920
          ],
          "size": [
            1280,
            500,
            920
          ]
        },
        "footprintStuds": [
          64,
          46
        ],
        "heightPlates": 62.5,
        "steps": 208,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "56 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 7940.15,
          "massLabel": "7.94 kg",
          "measuredParts": 4818,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "64.0 × 46.0 studs",
          "tippingMarginLdu": 294.45,
          "restingParts": 3059,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 4453,
        "connectionsAdded": 14047,
        "componentsBefore": 57,
        "componentsAfter": 1,
        "loosePartsBefore": 1344,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 7940.15,
        "massAfterGrams": 11946.91,
        "stepsBefore": 208,
        "stepsAfter": 100
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 6528
        },
        {
          "definitionId": "3007",
          "name": "Brick 2 x 8",
          "count": 855
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 795
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 335
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 99
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 97
        },
        {
          "definitionId": "2456",
          "name": "Brick 2 x 6",
          "count": 95
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 88
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 85
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 68
        },
        {
          "definitionId": "3001",
          "name": "Brick 2 x 4",
          "count": 61
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 33
        }
      ],
      "distinctParts": 23,
      "planWarnings": [
        "263 sculpted cell(s) had no course beneath them to clutch onto and were left out of Colossal Duck Float."
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
      "id": "iron-lattice-lookout",
      "title": "Iron Lattice Lookout",
      "discipline": "Landmark ironwork",
      "category": "landmarks",
      "tagline": "Two tapering tiers of open ironwork rise fifty-eight courses from an arched plinth to a glazed lookout and a clock stage.",
      "summary": "An original ironwork lookout you can see through. Each tier is twelve three-stud columns standing four to thirteen studs apart, with a zigzag brace sweeping up every face between them and a quarter-period offset so no two faces turn at the same height. The tiers taper as they climb, the plinth is cut by two crossing arched tunnels, and the crown carries an observation deck, a glazed pavilion and a clock stage whose four hands each sit on a real revolute hinge.",
      "techniques": [
        "Open lattice: twelve columns a tier, braced",
        "Zigzag face bracing, offset per elevation",
        "Two tiers tapering as they rise",
        "Arched masonry plinth on two crossing tunnels",
        "Cross-bonded cap courses under the ironwork",
        "Glazed observation pavilion",
        "Four independently hinged clock hands"
      ],
      "showcase": null,
      "refinement": "The first candidate bays its lattice on a one-layer plinth field whose parallel runs never bond, so the ironwork stands on loose plates and the tower stops less than halfway up. The published set cross-bonds the plinth, caps it with two bonded courses before the tiers go on, and carries the full height to the clock stage.",
      "hero": false,
      "tensionAllowance": 320,
      "tensionReason": "Each deck rests on the column tops beneath it rather than clutching down into them, and the clock hands hang from their hinge knuckles. The statics pass counts both as tension-carried; the allowance is bounded so a genuinely unsupported deck still fails the gate.",
      "brief": {
        "prompt": "An ironwork lookout tower you can see through: an arched stone plinth, two tiers of braced open lattice tapering as they rise, a glazed observation pavilion and a clock stage whose hands actually turn.",
        "envelopeStuds": [
          76,
          null,
          76
        ],
        "palette": [
          "Sand",
          "Light Bluish Grey",
          "Dark Bluish Grey",
          "White"
        ],
        "functions": [
          "Open lattice structure",
          "Articulated clock hands",
          "Arched ground level"
        ]
      },
      "camera": {
        "yaw": 30,
        "pitch": 14,
        "zoom": 1.02
      },
      "documentId": "demo_iron_lattice_lookout",
      "roughDocumentId": "demo_iron_lattice_lookout_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/iron-lattice-lookout/document.json",
          "bytes": 13529530,
          "sha256": "6caada0da583cb7c1c3ebaaf06be771b53baade65346733e7fe207487315ee01",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/iron-lattice-lookout/rough.json",
          "bytes": 10208662,
          "sha256": "fcb02278bb024373510c1ed730207ac2d2a81b531d474ee02c9bdaff1ae48eb7",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/iron-lattice-lookout/preview.json",
          "bytes": 456415,
          "sha256": "6a4478c48bd26021ce417d2e65beeea1696218cf3ea183dae0b6c80ab7671924",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/iron-lattice-lookout/rough-preview.json",
          "bytes": 434274,
          "sha256": "d3e1980ad5077761605d70c12515f4258ab37593db64b6eeec1b35c9f5a7b096",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/iron-lattice-lookout/thumb.png",
          "bytes": 33238,
          "sha256": "914536217f5e8dcc74ea342704fa5010ed48b652bdc2b8e5a96cfceb6f715663",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/iron-lattice-lookout/social.png",
          "bytes": 55951,
          "sha256": "eb99c375e31532a65b62ea6738bb74c22520625747b1f1e4121a3a2736a51955",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 8604,
        "connectionCount": 29402,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 32,
        "weakAttachmentCount": 4686,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -1556,
            0
          ],
          "max": [
            1520,
            0,
            1520
          ],
          "size": [
            1520,
            1556,
            1520
          ]
        },
        "footprintStuds": [
          76,
          76
        ],
        "heightPlates": 194.5,
        "steps": 138,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 10384.28,
          "massLabel": "10.38 kg",
          "measuredParts": 8604,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "76.0 × 76.0 studs",
          "tippingMarginLdu": 757.68,
          "restingParts": 464,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 28,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 7803,
        "connectionCount": 21016,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 159,
        "disconnectedPartCount": 5686,
        "virtualColorCount": 0,
        "weakAttachmentCount": 4667,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -788,
            0
          ],
          "max": [
            1520,
            0,
            1520
          ],
          "size": [
            1520,
            788,
            1520
          ]
        },
        "footprintStuds": [
          76,
          76
        ],
        "heightPlates": 98.5,
        "steps": 546,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "158 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "Step 34 adds part_6543 into a pose already enclosed by part_6645, part_6359 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 34 adds part_6549 into a pose already enclosed by part_6362, part_6529 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 34 adds part_6548 into a pose already enclosed by part_6362, part_6360 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 65 adds part_6182 into a pose already enclosed by part_6191, part_6155 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 8067.89,
          "massLabel": "8.07 kg",
          "measuredParts": 7803,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "76.0 × 76.0 studs",
          "tippingMarginLdu": 757.48,
          "restingParts": 6004,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 801,
        "connectionsAdded": 8386,
        "componentsBefore": 159,
        "componentsAfter": 1,
        "loosePartsBefore": 5686,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 28,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 8067.89,
        "massAfterGrams": 10384.28,
        "stepsBefore": 546,
        "stepsAfter": 138
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 5776
        },
        {
          "definitionId": "3007",
          "name": "Brick 2 x 8",
          "count": 667
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 300
        },
        {
          "definitionId": "3003",
          "name": "Brick 2 x 2",
          "count": 283
        },
        {
          "definitionId": "2456",
          "name": "Brick 2 x 6",
          "count": 212
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 195
        },
        {
          "definitionId": "3002",
          "name": "Brick 2 x 3",
          "count": 194
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 164
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 164
        },
        {
          "definitionId": "3001",
          "name": "Brick 2 x 4",
          "count": 147
        },
        {
          "definitionId": "3622",
          "name": "Brick 1 x 3",
          "count": 97
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 79
        }
      ],
      "distinctParts": 28,
      "planWarnings": [
        "1608 sculpted cell(s) had no course beneath them to clutch onto and were left out of Iron Lattice Lookout."
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
      "id": "harbour-control-tower",
      "title": "Harbour Control Tower",
      "discipline": "Play set",
      "category": "architecture",
      "tagline": "A 108-stud quay: two drive-through bays, eight container stacks, bunded tanks, a helipad and a glazed control room that overhangs its shaft.",
      "summary": "An original quayside play set rather than another facade. Two bays run straight through the podium so vehicles pass under it, the podium roof carries a painted helipad and a luffing crane, the cargo court is stacked with containers, and a hollow banded shaft rises to a glazed control room corbelled three studs a course out over every elevation, under an oversailing roof and a banded mast.",
      "techniques": [
        "Drive-through vehicle bays with stepped heads",
        "Control room corbelled out over the shaft",
        "Hollow glazed shaft, banded",
        "Painted helipad on the podium roof",
        "Eight container stacks and two bunded tanks",
        "Crane on a real luffing hinge"
      ],
      "showcase": null,
      "refinement": "The rough candidate is a single glazed block on a plain one-layer slab — a tower with nothing to do, its ground plane in loose plate runs that never bond. The published set cross-bonds the quay, cuts the podium open for vehicles, fills the cargo court, and puts a crane on the roof the joint solver can drive.",
      "hero": false,
      "tensionAllowance": 420,
      "tensionReason": "Glazing is seated inside its frames and the control-room floor and roof rest on the walls beneath them at the perimeter rather than clutching down into them. The statics pass counts both as tension-carried; the allowance is bounded so a genuinely unsupported deck still fails the gate.",
      "brief": {
        "prompt": "A quayside control tower with two drive-through vehicle bays under the podium, a helipad and working crane on the podium roof, container stacks and fuel tanks on the quay, and a glazed control room overhanging a tall shaft.",
        "envelopeStuds": [
          108,
          null,
          76
        ],
        "palette": [
          "Sand",
          "White",
          "Light Bluish Grey",
          "Dark Bluish Grey",
          "Yellow"
        ],
        "functions": [
          "Drive-in vehicle bays",
          "Luffing crane",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 36,
        "pitch": 22,
        "zoom": 1.04
      },
      "documentId": "demo_harbour_control_tower",
      "roughDocumentId": "demo_harbour_control_tower_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/harbour-control-tower/document.json",
          "bytes": 16162083,
          "sha256": "eb858a3c490839b3e207099d05833207fee90123364cea044b2825e7a8138415",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/harbour-control-tower/rough.json",
          "bytes": 9351043,
          "sha256": "242ccc02801d032d452e11f8d267552c8bdcb1c70a5794e51e080dec5b76badc",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/harbour-control-tower/preview.json",
          "bytes": 594111,
          "sha256": "f250f1b9fbe8be5df042deab7e0469b323a82bf1d3d07f8f070bc4e3d0003567",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/harbour-control-tower/rough-preview.json",
          "bytes": 364322,
          "sha256": "b39bfe1ebb283861ad352a3e4334782618412a2a16a42e756298c3776b238075",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/harbour-control-tower/thumb.png",
          "bytes": 32821,
          "sha256": "11c594ae8da6405616bb7925896fd8ddd2ce7f3ea9a7b6ca209cb5e2c89e6383",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/harbour-control-tower/social.png",
          "bytes": 56647,
          "sha256": "24dab34c16c4fdc46e0d3b889729f825a82a322fee3f62f486804c75893bc21a",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 11226,
        "connectionCount": 34940,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 140,
        "weakAttachmentCount": 6936,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -1516,
            0
          ],
          "max": [
            2160,
            0,
            1520
          ],
          "size": [
            2160,
            1516,
            1520
          ]
        },
        "footprintStuds": [
          108,
          76
        ],
        "heightPlates": 189.5,
        "steps": 161,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "Step 153 adds part_10856 into a pose already enclosed by part_10863, part_10838 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 153 adds part_10858 into a pose already enclosed by part_10867, part_10842 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 153 adds part_10859 into a pose already enclosed by part_10880, part_10876 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 11812.56,
          "massLabel": "11.81 kg",
          "measuredParts": 11226,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "108.0 × 76.0 studs",
          "tippingMarginLdu": 651.94,
          "restingParts": 620,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 11,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 6702,
        "connectionCount": 19575,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 107,
        "disconnectedPartCount": 3326,
        "virtualColorCount": 74,
        "weakAttachmentCount": 3635,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -836,
            0
          ],
          "max": [
            1680,
            0,
            1120
          ],
          "size": [
            1680,
            836,
            1120
          ]
        },
        "footprintStuds": [
          84,
          56
        ],
        "heightPlates": 104.5,
        "steps": 384,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "106 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "Step 12 adds part_5489 into a pose already enclosed by part_5293, part_5486 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 12 adds part_5505 into a pose already enclosed by part_5296, part_5502 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 13 adds part_5494 into a pose already enclosed by part_5294, part_5489 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 13 adds part_5499 into a pose already enclosed by part_5295, part_5293 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 13 adds part_5632 into a pose already enclosed by part_5502, part_5489 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 13 adds part_5616 into a pose already enclosed by part_5832, part_5486 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 13 adds part_5617 into a pose already enclosed by part_5618, part_5489 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 14 adds part_5827 into a pose already enclosed by part_5832, part_5615 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 15 adds part_5945 into a pose already enclosed by part_5836, part_5944 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 17 adds part_5506 into a pose already enclosed by part_5364, part_5503 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 18 adds part_5497 into a pose already enclosed by part_5362, part_5490 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 18 adds part_5500 into a pose already enclosed by part_5363, part_5361 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 18 adds part_5678 into a pose already enclosed by part_5503, part_5490 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 18 adds part_5677 into a pose already enclosed by part_5693, part_5490 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 19 adds part_5837 into a pose already enclosed by part_5656, part_5833 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 20 adds part_5988 into a pose already enclosed by part_5841, part_5987 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 21 adds part_6145 into a pose already enclosed by part_6157, part_5985 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 7427.21,
          "massLabel": "7.43 kg",
          "measuredParts": 6702,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "84.0 × 56.0 studs",
          "tippingMarginLdu": 538.45,
          "restingParts": 4872,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 4524,
        "connectionsAdded": 15365,
        "componentsBefore": 107,
        "componentsAfter": 1,
        "loosePartsBefore": 3326,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 11,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 7427.21,
        "massAfterGrams": 11812.56,
        "stepsBefore": 384,
        "stepsAfter": 161
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 8208
        },
        {
          "definitionId": "3007",
          "name": "Brick 2 x 8",
          "count": 559
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 450
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 396
        },
        {
          "definitionId": "3001",
          "name": "Brick 2 x 4",
          "count": 384
        },
        {
          "definitionId": "2456",
          "name": "Brick 2 x 6",
          "count": 281
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 278
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 161
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 91
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 84
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 50
        },
        {
          "definitionId": "3022",
          "name": "Plate 2 x 2",
          "count": 44
        }
      ],
      "distinctParts": 28,
      "planWarnings": [
        "2218 sculpted cell(s) had no course beneath them to clutch onto and were left out of Harbour Control Tower."
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
      "id": "saucer-freighter",
      "title": "Saucer Freighter",
      "discipline": "Vehicle and mechanism",
      "category": "vehicles",
      "tagline": "A ninety-six-stud freighter on six landing legs: deep tapering hull, stepped upper deck, raised bridge and three lit engine bells.",
      "summary": "An original freighter shaped as a 3D solid and stood clear of its apron. The planform runs from a blunt stern through a parallel midbody to a pointed bow, the hull is chamfered top and bottom rather than extruded, a stepped upper deck carries a glazed bridge forward and a dorsal spine aft, and three engine bells glow at the stern. Everything above the legs corbels out of them course by course, so the underbelly tapers into the gear instead of hanging in the air. Two real hinges — a boarding flap and a dorsal turret — are driven by the kernel’s own joint solver.",
      "techniques": [
        "3D voxel solid, not a plate stack",
        "Six landing legs with daylight beneath the hull",
        "Tapered lozenge planform, pointed bow",
        "Chamfered hull section",
        "Glazed bridge over a stepped upper deck",
        "Three lit engine bells",
        "Two flaps on real hinges"
      ],
      "showcase": null,
      "refinement": "The rough candidate is a single rectangular slab lying on the apron with the cockpit sitting on top of it — a box with a windscreen, and loose one-layer ground under it. The published set lifts the ship onto six legs, gives it a tapering chamfered hull twelve courses deep, and puts a bridge, a spine and three engines on it.",
      "hero": false,
      "tensionAllowance": 640,
      "tensionReason": "The hinged flaps rest on their knuckles rather than clutching down into the deck, and the bridge glazing is seated in its frame. The statics pass counts both as tension-carried; the allowance is bounded so an actually unsupported hull panel still fails the gate.",
      "brief": {
        "prompt": "An original saucer freighter standing on landing legs, with a deep tapering hull, a pointed bow, a stepped upper deck, a glazed bridge, three engine bells and two flaps that open.",
        "envelopeStuds": [
          96,
          null,
          64
        ],
        "palette": [
          "Light Bluish Grey",
          "Dark Bluish Grey",
          "Dark Tan",
          "Trans Neon Orange"
        ],
        "functions": [
          "Hinged boarding flap",
          "Hinged dorsal turret",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 40,
        "pitch": 26,
        "zoom": 1.04
      },
      "documentId": "demo_saucer_freighter",
      "roughDocumentId": "demo_saucer_freighter_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/saucer-freighter/document.json",
          "bytes": 23954137,
          "sha256": "8e7fd2a12463ff21322e8bb631203d3b131188e671b387ed2677d1e656c4f759",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/saucer-freighter/rough.json",
          "bytes": 11155830,
          "sha256": "66b4fe48aadbcb7b04e8d69c7681a26de19a71a24f4c46ac9bcf10f285b05751",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/saucer-freighter/preview.json",
          "bytes": 548465,
          "sha256": "0573d917ad4e01957e5b5a0752c2263bb5784f4a82e19da4c4d7d369ebd76587",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/saucer-freighter/rough-preview.json",
          "bytes": 310710,
          "sha256": "0d60b58817473cc11bf087c35a3241c62405e05dc81c21ec98a1fec85560410c",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/saucer-freighter/thumb.png",
          "bytes": 45466,
          "sha256": "a8b68cf52c979ca10af253ac05f8acce5d50fdb6fd613f5193531f7c34ee2881",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/saucer-freighter/social.png",
          "bytes": 80121,
          "sha256": "fde2da77895179063606dfcde2ac4636a2a96bcc2496acc85c89af34564e3c65",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 10338,
        "connectionCount": 52990,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 426,
        "weakAttachmentCount": 5858,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -772,
            0
          ],
          "max": [
            1920,
            0,
            1280
          ],
          "size": [
            1920,
            772,
            1280
          ]
        },
        "footprintStuds": [
          96,
          64
        ],
        "heightPlates": 96.5,
        "steps": 165,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "Step 164 adds part_10175 into a pose already enclosed by part_10166, part_10157 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 164 adds part_10198 into a pose already enclosed by part_10193, part_10225 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 18360.97,
          "massLabel": "18.36 kg",
          "measuredParts": 10338,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "96.0 × 64.0 studs",
          "tippingMarginLdu": 639.13,
          "restingParts": 459,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 8,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 5594,
        "connectionCount": 23852,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 115,
        "disconnectedPartCount": 3242,
        "virtualColorCount": 18,
        "weakAttachmentCount": 3408,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -428,
            0
          ],
          "max": [
            1400,
            0,
            1040
          ],
          "size": [
            1400,
            428,
            1040
          ]
        },
        "footprintStuds": [
          70,
          52
        ],
        "heightPlates": 53.5,
        "steps": 383,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "114 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "Step 8 adds part_4044 into a pose already enclosed by part_4039, part_4027 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_3845 into a pose already enclosed by part_3824, part_3885 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_3846 into a pose already enclosed by part_3824, part_3864. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_3865 into a pose already enclosed by part_3885, part_3864 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_3866 into a pose already enclosed by part_3885, part_3844. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_3886 into a pose already enclosed by part_3864, part_3916 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 10 adds part_3842 into a pose already enclosed by part_3814, part_3882 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 10 adds part_3843 into a pose already enclosed by part_3814, part_3854. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 10 adds part_3855 into a pose already enclosed by part_3882, part_3854 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 10 adds part_3856 into a pose already enclosed by part_3882, part_3841. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 10 adds part_3883 into a pose already enclosed by part_3854, part_3900 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 10 adds part_3888 into a pose already enclosed by part_3900, part_3854. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 10 adds part_3901 into a pose already enclosed by part_3882, part_3900 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 10 adds part_3902 into a pose already enclosed by part_3989, part_3882. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 10 adds part_3971 into a pose already enclosed by part_3989, part_4057 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 11 adds part_4094 into a pose already enclosed by part_4097, part_4081 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 9080.9,
          "massLabel": "9.08 kg",
          "measuredParts": 5594,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "70.0 × 52.0 studs",
          "tippingMarginLdu": 425.75,
          "restingParts": 3770,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 4744,
        "connectionsAdded": 29138,
        "componentsBefore": 115,
        "componentsAfter": 1,
        "loosePartsBefore": 3242,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 8,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 9080.9,
        "massAfterGrams": 18360.97,
        "stepsBefore": 383,
        "stepsAfter": 165
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 6144
        },
        {
          "definitionId": "3007",
          "name": "Brick 2 x 8",
          "count": 2007
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 825
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 315
        },
        {
          "definitionId": "2456",
          "name": "Brick 2 x 6",
          "count": 137
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 130
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 129
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 127
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 114
        },
        {
          "definitionId": "3001",
          "name": "Brick 2 x 4",
          "count": 77
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 64
        },
        {
          "definitionId": "3003",
          "name": "Brick 2 x 2",
          "count": 53
        }
      ],
      "distinctParts": 23,
      "planWarnings": [
        "1998 sculpted cell(s) had no course beneath them to clutch onto and were left out of Saucer Freighter."
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
      "id": "harbour-street",
      "title": "Harbour Street",
      "discipline": "Modular architecture",
      "category": "architecture",
      "tagline": "Seven four-storey shopfronts under three different rooflines — pitched gables with chimneys, stepped parapets and flat roofs with roof rooms.",
      "summary": "Seven four-storey shopfronts on a full street district. Every address lifts out, every floor lifts off, and the public realm is built at the same editable grain. Each address takes one of three rooflines — a pitched gable laid as hollow stepped brick bands with a chimney stack, a stepped parapet on corner piers, or a flat roof with its own glazed roof room — so the terrace reads as seven buildings rather than one long shell.",
      "techniques": [
        "One subassembly per storey, per unit",
        "Tiled carriageway, kerb and pavement",
        "Seated shopfront doors and glazing",
        "Three rooflines: pitched, stepped parapet, flat",
        "Hollow stepped gables with chimney stacks",
        "Two-stud alleys and individual roof rooms",
        "Street trees, lamps and planted thresholds"
      ],
      "showcase": null,
      "refinement": "The first candidate laid the terrace as one continuous shell on a painted ground plane, so nothing came apart and the street was a texture. The published set separates every unit and every floor, and lays the road surface as individual tiles.",
      "hero": false,
      "tensionAllowance": 480,
      "tensionReason": "Glazing is seated inside its frames and each storey deck rests on the walls below it at the perimeter rather than clutching down into them. The statics pass counts both as tension-carried; the allowance is bounded so a genuinely unsupported storey still fails.",
      "brief": {
        "prompt": "A street of seven four-storey modular shops with flats above, separate alleys, three different rooflines with chimneys and roof rooms, trees, lights and planted thresholds, where every building and every floor can be lifted off separately.",
        "envelopeStuds": [
          134,
          null,
          50
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
        "pitch": 28,
        "zoom": 1.08
      },
      "documentId": "demo_harbour_street",
      "roughDocumentId": "demo_harbour_street_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/harbour-street/document.json",
          "bytes": 13090655,
          "sha256": "32e81d50c4e60ff23ca70bfca954057761dd83e5e5382c3329ad598baf891854",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/harbour-street/rough.json",
          "bytes": 1299421,
          "sha256": "c717816a50e1d2d0d33d6d8fc8fcff4262b45b285e6118a56a483e1e9cd46184",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/harbour-street/preview.json",
          "bytes": 433393,
          "sha256": "21e8a468f9bf2d37a7ece55f69596a4b61de727f6d1fae8f2e9cfabc9d504110",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/harbour-street/rough-preview.json",
          "bytes": 62678,
          "sha256": "d5760e2afecc6c5a60a7ffef4c7c4141b8d9a489cad636d05ca133ea7b594ea1",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/harbour-street/thumb.png",
          "bytes": 38770,
          "sha256": "1878303fc79084a1ab7984d30eff47b5d829cdfb2ad9f16bf77bdf7ed0e5d572",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/harbour-street/social.png",
          "bytes": 63868,
          "sha256": "d67ecb52d0bd2a02885ad04afa963c897e392e9a51ea03bcf5dfd5506b0a1ddd",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 7947,
        "connectionCount": 29697,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 38,
        "weakAttachmentCount": 4732,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -828,
            0
          ],
          "max": [
            2680,
            0,
            1000
          ],
          "size": [
            2680,
            828,
            1000
          ]
        },
        "footprintStuds": [
          134,
          50
        ],
        "heightPlates": 103.5,
        "steps": 114,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 9905.31,
          "massLabel": "9.91 kg",
          "measuredParts": 7947,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "134.0 × 50.0 studs",
          "tippingMarginLdu": 383.79,
          "restingParts": 466,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 148,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 1121,
        "connectionCount": 2678,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 34,
        "disconnectedPartCount": 673,
        "virtualColorCount": 1,
        "weakAttachmentCount": 712,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -404,
            0
          ],
          "max": [
            680,
            0,
            680
          ],
          "size": [
            680,
            404,
            680
          ]
        },
        "footprintStuds": [
          34,
          34
        ],
        "heightPlates": 50.5,
        "steps": 42,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "33 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 1076.92,
          "massLabel": "1.08 kg",
          "measuredParts": 1121,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "34.0 × 34.0 studs",
          "tippingMarginLdu": 275.66,
          "restingParts": 763,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 16,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 6826,
        "connectionsAdded": 27019,
        "componentsBefore": 34,
        "componentsAfter": 1,
        "loosePartsBefore": 673,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 16,
        "unsupportedAfter": 148,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 1076.92,
        "massAfterGrams": 9905.31,
        "stepsBefore": 42,
        "stepsAfter": 114
      },
      "bill": [
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 4497
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 554
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 473
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 343
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 244
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 234
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 220
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 216
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 162
        },
        {
          "definitionId": "60592",
          "name": "Window 1 x 2 x 2 Flat Front",
          "count": 148
        },
        {
          "definitionId": "60601",
          "name": "Glass for Window 1 x 2 x 2 Flat",
          "count": 148
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 128
        }
      ],
      "distinctParts": 32,
      "planWarnings": [
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
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
      "category": "architecture",
      "tagline": "A twenty-eight-storey modular high-rise with two setbacks, a seven-course crown and a 108-stud civic plaza.",
      "summary": "Twenty-eight storeys, each its own subassembly, step through three distinct tower volumes to a seven-course crown and a banded mast. Beneath them a 108 x 72-stud civic plaza carries a reflecting pool, a glazed pavilion, thirty-odd street trees, lit approach posts, planted beds and a crowd, all laid one tile at a time so the public realm is editable at the same grain as the building.",
      "techniques": [
        "One subassembly per storey",
        "Cross-bonded deck between floors",
        "Seated window frames on every elevation",
        "Stepped crown and mast",
        "Two structural setbacks",
        "Landscaped 108 x 72-stud plaza, pavilion and reflecting pool"
      ],
      "showcase": null,
      "refinement": "The massing study stacked the storeys as one continuous shell, so there was no seam to lift and the facades were blank. The published set separates every floor onto its own two-layer deck and glazes the elevations with frames the catalogue actually compiles.",
      "hero": false,
      "tensionAllowance": 1100,
      "tensionReason": "Two things in this model are held in bearing rather than in clutch, and the statics pass counts both as tension-carried. The glazing is seated inside its frames, and the middle of each storey deck rests on the walls below it at the perimeter rather than clutching down into them. The two setback transfer decks use the same bearing condition. All three are how a modular building is actually assembled; the allowance is bounded so a genuinely floating storey still fails the gate.",
      "brief": {
        "prompt": "A twenty-eight-storey modular tower on a large landscaped civic plaza with a reflecting pool and a pavilion, where every floor lifts off separately, the elevations carry real windows, two upper volumes set back, and the crown rises to a banded mast.",
        "envelopeStuds": [
          108,
          null,
          72
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
        "pitch": 30,
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
          "bytes": 23786164,
          "sha256": "7f8ba816e9c07e0aab976e103db7abbab11708169a7df8be431d7667a7669e52",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/meridian-tower/rough.json",
          "bytes": 3454241,
          "sha256": "5b8277518acae2d3ddefbc50c3971c49fabcc272cbde145cc25bd6c7bc673d0f",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/meridian-tower/preview.json",
          "bytes": 704060,
          "sha256": "9a026e0a7bf9e35f48c2b44662a04d4be71db82b461a96a499c96a55eefe9c6e",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/meridian-tower/rough-preview.json",
          "bytes": 119009,
          "sha256": "703c6e37190d9597fed628d4cc4da8ce7da47b0e2383cc5b0d57159ba8d64705",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/meridian-tower/thumb.png",
          "bytes": 19802,
          "sha256": "43df99c85c1da0c14dde1dbc8642d8f639fa30c2ca411a68fa2d48cde32f6e71",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/meridian-tower/social.png",
          "bytes": 30976,
          "sha256": "6d57009eaf744dbaa9ef5f03d6fdcb4106f7ba30debce6e74e90706555b76b33",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 12639,
        "connectionCount": 55021,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 188,
        "weakAttachmentCount": 7122,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -4484,
            0
          ],
          "max": [
            2160,
            0,
            1440
          ],
          "size": [
            2160,
            4484,
            1440
          ]
        },
        "footprintStuds": [
          108,
          72
        ],
        "heightPlates": 560.5,
        "steps": 188,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 18255.88,
          "massLabel": "18.26 kg",
          "measuredParts": 12639,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "108.0 × 72.0 studs",
          "tippingMarginLdu": 719.95,
          "restingParts": 588,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 855,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 2172,
        "connectionCount": 7724,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 53,
        "disconnectedPartCount": 1060,
        "virtualColorCount": 15,
        "weakAttachmentCount": 1337,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -1212,
            0
          ],
          "max": [
            1160,
            0,
            600
          ],
          "size": [
            1160,
            1212,
            600
          ]
        },
        "footprintStuds": [
          58,
          30
        ],
        "heightPlates": 151.5,
        "steps": 70,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "52 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly.",
          "8 parts have no connection at all and cannot be attached in any step."
        ],
        "statics": {
          "massGrams": 2853.83,
          "massLabel": "2.85 kg",
          "measuredParts": 2172,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "58.0 × 30.0 studs",
          "tippingMarginLdu": 299.97,
          "restingParts": 1342,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 90,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 10467,
        "connectionsAdded": 47297,
        "componentsBefore": 53,
        "componentsAfter": 1,
        "loosePartsBefore": 1060,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 90,
        "unsupportedAfter": 855,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 2853.83,
        "massAfterGrams": 18255.88,
        "stepsBefore": 70,
        "stepsAfter": 188
      },
      "bill": [
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 6553
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 1177
        },
        {
          "definitionId": "3622",
          "name": "Brick 1 x 3",
          "count": 934
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 498
        },
        {
          "definitionId": "60592",
          "name": "Window 1 x 2 x 2 Flat Front",
          "count": 470
        },
        {
          "definitionId": "60601",
          "name": "Glass for Window 1 x 2 x 2 Flat",
          "count": 470
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 367
        },
        {
          "definitionId": "2465",
          "name": "Brick 1 x 16",
          "count": 360
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 237
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 194
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 178
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 156
        }
      ],
      "distinctParts": 35,
      "planWarnings": [
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there.",
        "Course 4 shares 1 seam(s) with the course below over a 46-stud run; the available lengths do not permit a full stagger there."
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
      "id": "illinois-main-quad",
      "title": "Illinois Main Quad campus",
      "discipline": "Campus architecture",
      "category": "architecture",
      "tagline": "A 128 × 88-stud university campus with nine landmark structures, a tiled quad, mature trees, path lights and 21 LEGO characters.",
      "summary": "A display-scale UIUC campus set anchored by the Illini Union and Foellinger Auditorium, with Altgeld Hall, Alma Mater, six flanking academic blocks, the Main Quad path geometry, Morrow Plots, mature trees and brick-built students, an east visitor hall and a south garden pavilion. Six of the halls carry pitched gable roofs laid as hollow stepped brick bands in three tile colours, so the campus reads as buildings rather than as a site plan. The site finish alone is 11,264 individually editable pieces over a cross-bonded base.",
      "techniques": [
        "10,000+ catalog-backed pieces",
        "Cross-bonded 128 × 88-stud foundation",
        "Nine landmark structures",
        "Pitched gable roofs on six academic halls",
        "Stepped copper dome, cupola and bell tower",
        "18 campus figures",
        "Three-figure Alma Mater group",
        "Twenty-eight mature trees and sixteen path lights"
      ],
      "showcase": {
        "landmarkCount": 9,
        "characterCount": 21,
        "siteFinishParts": 11264
      },
      "refinement": "The massing study established the Main Quad axis on a one-layer field, but its plate runs were disconnected. The published set cross-bonds the entire site, replaces the massing blocks with detailed landmark buildings under pitched roofs, and adds the 11,264-piece landscape, characters and buildable campus life.",
      "hero": true,
      "tensionAllowance": 256,
      "tensionReason": "Window panes are seated inside their frames rather than carried in vertical compression. The statics pass counts those glazed inserts as tension-carried, measures their mass, and still checks every attachment group against the conservative clutch assumption.",
      "brief": {
        "prompt": "Build a display-scale replica of the University of Illinois Main Quad with the Union and Foellinger on axis, Altgeld and Alma Mater, pitched-roof academic halls, Morrow Plots, trees, paths, and enough students to make it feel alive. It must exceed ten thousand real pieces and still pass the physical kernel.",
        "envelopeStuds": [
          128,
          null,
          88
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
        "zoom": 1.02
      },
      "documentId": "demo_illinois_main_quad",
      "roughDocumentId": "demo_illinois_main_quad_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/illinois-main-quad/document.json",
          "bytes": 14882387,
          "sha256": "9e25862b2a36f121317ed797aec819cc2ba98d2c019ecd4cc58914d8516bf5d9",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/illinois-main-quad/rough.json",
          "bytes": 480961,
          "sha256": "2213ec6f5cb27a2928e2f7e4d7301619362d484e84b12f517ff11602058b860b",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/illinois-main-quad/preview.json",
          "bytes": 745413,
          "sha256": "ba571d4a173d0f565b658a0c059d22b724853977be476ed0bf80625bd1936fe3",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/illinois-main-quad/rough-preview.json",
          "bytes": 38144,
          "sha256": "724922b053f44cd9964ca9a5d8ef12e9dba9519cdcc7cdd405a4aca88e44ac83",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/illinois-main-quad/thumb.png",
          "bytes": 49906,
          "sha256": "456da25e4e67dea733be18f1ff29f8e11a971ab4a722b1e8e169095206cbfcef",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/illinois-main-quad/social.png",
          "bytes": 83106,
          "sha256": "2913eecbfd5385e55a3cbbae6b5f0629f6ca43de8b6c335e6bd13c1da608c188",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 13835,
        "connectionCount": 31234,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 93,
        "weakAttachmentCount": 10638,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -524,
            0
          ],
          "max": [
            2560,
            0,
            1760
          ],
          "size": [
            2560,
            524,
            1760
          ]
        },
        "footprintStuds": [
          128,
          88
        ],
        "heightPlates": 65.5,
        "steps": 221,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 10055.44,
          "massLabel": "10.06 kg",
          "measuredParts": 13835,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "128.0 × 88.0 studs",
          "tippingMarginLdu": 837.66,
          "restingParts": 807,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 70,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 426,
        "connectionCount": 916,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 206,
        "disconnectedPartCount": 352,
        "virtualColorCount": 24,
        "weakAttachmentCount": 90,
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
          "massGrams": 2075.86,
          "massLabel": "2.08 kg",
          "measuredParts": 426,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "120.0 × 80.0 studs",
          "tippingMarginLdu": 785.75,
          "restingParts": 368,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 13409,
        "connectionsAdded": 30318,
        "componentsBefore": 206,
        "componentsAfter": 1,
        "loosePartsBefore": 352,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 70,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 2075.86,
        "massAfterGrams": 10055.44,
        "stepsBefore": 214,
        "stepsAfter": 221
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 9610
        },
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 1657
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 637
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 282
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 255
        },
        {
          "definitionId": "3622",
          "name": "Brick 1 x 3",
          "count": 148
        },
        {
          "definitionId": "2456",
          "name": "Brick 2 x 6",
          "count": 147
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 125
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 98
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 74
        },
        {
          "definitionId": "3006",
          "name": "Brick 2 x 10",
          "count": 73
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 68
        }
      ],
      "distinctParts": 39,
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
