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
      "tagline": "An eighty-four-stud blue whale with fins, flukes and foam rising from an illuminated ocean promenade.",
      "summary": "A display-scale whale built as hundreds of individually editable stud columns over a fully tiled ocean scene. The body swells in measured brick courses, the flukes spread across the water, and a white eye-and-foam pass keeps the silhouette readable from every orbit. Fourteen lit promenade posts and planted reef markers frame the monument without crowding it.",
      "techniques": [
        "Voxel-sculpted animal anatomy",
        "Cross-bonded 84 x 42-stud plinth",
        "Editable ocean mosaic",
        "Layered fins and flukes",
        "Illuminated aquarium promenade"
      ],
      "showcase": null,
      "refinement": "The first candidate put a simplified whale on a one-layer plate field whose parallel runs stayed disconnected. The published monument cross-bonds the complete ocean plinth and expands the body, fins, flukes and surface detail.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": {
        "prompt": "A large brick-built blue whale monument with a readable body, broad flukes, side fins and white foam, mounted over an editable ocean mosaic.",
        "envelopeStuds": [
          84,
          null,
          42
        ],
        "palette": [
          "Medium Blue",
          "Trans Light Blue",
          "White",
          "Dark Bluish Grey"
        ],
        "functions": [
          "Large animal figure",
          "Editable water scene",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 34,
        "pitch": 48,
        "zoom": 1.08
      },
      "documentId": "demo_blue_whale_monument",
      "roughDocumentId": "demo_blue_whale_monument_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/blue-whale-monument/document.json",
          "bytes": 9231496,
          "sha256": "e5a1d9239e55fab1cac6dcc26d10eefc0967b1af7159a34c8eda29c22b76109a",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/blue-whale-monument/rough.json",
          "bytes": 1220786,
          "sha256": "a73972ee0982238ce1be4984f0ac057e1ef4bf64a6826c7cf469204072feff54",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/blue-whale-monument/preview.json",
          "bytes": 662320,
          "sha256": "d3576ef86cc6865af3ee4ddaab4f8d0882956f2a9aeb8fb8cb40fd3961ca0ee4",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/blue-whale-monument/rough-preview.json",
          "bytes": 108756,
          "sha256": "603a419cd120914f0f5ae36067278e00b5d016fcca362e21c64bb8efec0044f3",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/blue-whale-monument/thumb.png",
          "bytes": 40676,
          "sha256": "203e45d5f7839a9aeb4e85591db10cbb54050bd1f20d5f2bad5c0d43faad045f",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/blue-whale-monument/social.png",
          "bytes": 80291,
          "sha256": "8c529f06931ddb369e5ab1175337f55ae273e5f81ec1b1bc4ea46b5ee6beaa4d",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 12794,
        "connectionCount": 16059,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 0,
        "weakAttachmentCount": 3528,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -292,
            0
          ],
          "max": [
            1680,
            0,
            840
          ],
          "size": [
            1680,
            292,
            840
          ]
        },
        "footprintStuds": [
          84,
          42
        ],
        "heightPlates": 36.5,
        "steps": 135,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 6282.84,
          "massLabel": "6.28 kg",
          "measuredParts": 12794,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "84.0 × 42.0 studs",
          "tippingMarginLdu": 413.19,
          "restingParts": 263,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 1976,
        "connectionCount": 1937,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 39,
        "disconnectedPartCount": 1824,
        "virtualColorCount": 0,
        "weakAttachmentCount": 924,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -116,
            0
          ],
          "max": [
            840,
            0,
            440
          ],
          "size": [
            840,
            116,
            440
          ]
        },
        "footprintStuds": [
          42,
          22
        ],
        "heightPlates": 14.5,
        "steps": 173,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "38 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 840.04,
          "massLabel": "840 g",
          "measuredParts": 1976,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "42.0 × 22.0 studs",
          "tippingMarginLdu": 214.2,
          "restingParts": 963,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 10818,
        "connectionsAdded": 14122,
        "componentsBefore": 39,
        "componentsAfter": 1,
        "loosePartsBefore": 1824,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 840.04,
        "massAfterGrams": 6282.84,
        "stepsBefore": 173,
        "stepsAfter": 135
      },
      "bill": [
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 8918
        },
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 3529
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 164
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 67
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 40
        },
        {
          "definitionId": "2445",
          "name": "Plate 2 x 12",
          "count": 21
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 21
        },
        {
          "definitionId": "6141",
          "name": "Plate Round 1 x 1 with Solid Stud",
          "count": 14
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 12
        },
        {
          "definitionId": "32607",
          "name": "Plant, Plate 1 x 1 Round with 3 Leaves",
          "count": 4
        },
        {
          "definitionId": "3666",
          "name": "Plate 1 x 6",
          "count": 3
        },
        {
          "definitionId": "78329",
          "name": "Plate 1 x 5",
          "count": 1
        }
      ],
      "distinctParts": 12,
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
      "id": "sunline-suspension-bridge",
      "title": "Sunline Suspension Bridge",
      "discipline": "Landmark infrastructure",
      "category": "landmarks",
      "tagline": "Twin brick-red gateways carry a raised road and stepped golden hangers across a 120-stud river district.",
      "summary": "An original city landmark on a fully editable river: a cross-bonded road deck raised on six masonry piers, twin eighteen-course gateway towers, smooth traffic lanes, landscaped banks and honest stud-connected hanger columns tracing the suspension profile on both edges.",
      "techniques": [
        "120 x 50-stud river district",
        "Twin masonry gateway towers",
        "Six structural river piers",
        "Cross-bonded suspended deck",
        "Stepped catenary hangers",
        "Landscaped, illuminated approaches"
      ],
      "showcase": null,
      "refinement": "The first candidate stopped at a one-layer river study, leaving its plate runs disconnected and no crossing between the banks. The published build cross-bonds the river, adds the complete road deck, towers, lanes and two lines of suspension hangers.",
      "hero": false,
      "tensionAllowance": 320,
      "tensionReason": "The bonded tower caps rest on perimeter masonry and the statics pass counts their interior plates as tension-carried. The allowance is bounded so a floating deck or tower still fails.",
      "brief": {
        "prompt": "An original large suspension bridge with twin brick-red gateway towers, a long road deck, golden vertical hangers and a fully editable river beneath it.",
        "envelopeStuds": [
          120,
          null,
          50
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
        "yaw": 32,
        "pitch": 42,
        "zoom": 1.04
      },
      "documentId": "demo_sunline_suspension_bridge",
      "roughDocumentId": "demo_sunline_suspension_bridge_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/sunline-suspension-bridge/document.json",
          "bytes": 7961487,
          "sha256": "ea28b819d22399aca598cb72f6b47d33ddf1b8332512bcead62915363d763824",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/sunline-suspension-bridge/rough.json",
          "bytes": 755833,
          "sha256": "a62ee9bb34bf950d1e136548b989f9fd49fc6430867c7c2969006d147434c946",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/sunline-suspension-bridge/preview.json",
          "bytes": 415746,
          "sha256": "40dcac5f1d303ff39fd282429788d6af04af5a1ce144a29cf68f08931a4bea66",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/sunline-suspension-bridge/rough-preview.json",
          "bytes": 71201,
          "sha256": "f2f5f3533cdd25ba4a0bb954980e15250db0549bb91de3c62d06b0c9024ca252",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/sunline-suspension-bridge/thumb.png",
          "bytes": 49033,
          "sha256": "d5ccff8b6f06196ff258b676413e25201184a993921fe0d64909b5023f00d95c",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/sunline-suspension-bridge/social.png",
          "bytes": 85854,
          "sha256": "220c4a56b986fd56f59a5c97eafbbebb0852e9854be3cf4fd15dd01d9a48a5c0",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 8021,
        "connectionCount": 16433,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 21,
        "weakAttachmentCount": 6577,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -580,
            0
          ],
          "max": [
            2400,
            0,
            1000
          ],
          "size": [
            2400,
            580,
            1000
          ]
        },
        "footprintStuds": [
          120,
          50
        ],
        "heightPlates": 72.5,
        "steps": 87,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 4972.88,
          "massLabel": "4.97 kg",
          "measuredParts": 8021,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "120.0 × 50.0 studs",
          "tippingMarginLdu": 499.97,
          "restingParts": 415,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 19,
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
        "partsAdded": 6745,
        "connectionsAdded": 15201,
        "componentsBefore": 44,
        "componentsAfter": 1,
        "loosePartsBefore": 1243,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 19,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 469.8,
        "massAfterGrams": 4972.88,
        "stepsBefore": 131,
        "stepsAfter": 87
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 5809
        },
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 704
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 530
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 369
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 140
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 89
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 80
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 72
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 60
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 34
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 28
        },
        {
          "definitionId": "91988",
          "name": "Plate 2 x 14",
          "count": 28
        }
      ],
      "distinctParts": 20,
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
      "tagline": "A brick-built mammoth with a domed back, four legs, a long trunk, amber ears and paired ivory tusks.",
      "summary": "A large animal figure shaped column by column over a copper-and-sand canyon floor. The broad body, lowered head, grounded legs, trunk, ears and white tusks remain separate editable regions of the same physically connected model.",
      "techniques": [
        "Voxel-sculpted quadruped anatomy",
        "Grounded four-leg silhouette",
        "Ivory tusk accents",
        "Editable canyon mosaic",
        "Canyon pines and trail lighting"
      ],
      "showcase": null,
      "refinement": "The first candidate used a smaller silhouette over loose plate runs. The published figure cross-bonds a sixty-eight-stud scene and resolves the mammoth into a fuller body, grounded legs, ears, trunk and paired tusks.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": {
        "prompt": "A large brick-built woolly mammoth with a massive rounded body, four grounded legs, a lowered trunk, amber ears and white tusks on a canyon display plinth.",
        "envelopeStuds": [
          68,
          null,
          44
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
        "yaw": 38,
        "pitch": 45,
        "zoom": 1.08
      },
      "documentId": "demo_copper_mammoth",
      "roughDocumentId": "demo_copper_mammoth_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/copper-mammoth/document.json",
          "bytes": 6888011,
          "sha256": "95c407dad4dafa2256bf54a611d90c7f4245a3d41246e7986d2496ec3cb99c4f",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/copper-mammoth/rough.json",
          "bytes": 884446,
          "sha256": "70aff2c4f9160386e3caf5969a4591a24325002ce3bc51be936ae30c9ad82350",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/copper-mammoth/preview.json",
          "bytes": 480080,
          "sha256": "894e37ad4ec91f7d70efa9866137face76ef7fb2d22b5de7212f4d960470c372",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/copper-mammoth/rough-preview.json",
          "bytes": 79349,
          "sha256": "d9374932dd29e6e0e67f3471117846646d2e36e553201421610a4127bcb01e5a",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/copper-mammoth/thumb.png",
          "bytes": 49327,
          "sha256": "e426be4173050dc2a0b8b934676a11aaa2e416527a616577f2ca8131d6603a97",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/copper-mammoth/social.png",
          "bytes": 89098,
          "sha256": "f60e33bf8c13044048fe70ac3440f39e823f01e7a0ce775e8d67be088769058d",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 9421,
        "connectionCount": 12184,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 15,
        "weakAttachmentCount": 2992,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -292,
            0
          ],
          "max": [
            1360,
            0,
            880
          ],
          "size": [
            1360,
            292,
            880
          ]
        },
        "footprintStuds": [
          68,
          44
        ],
        "heightPlates": 36.5,
        "steps": 101,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 4645.69,
          "massLabel": "4.65 kg",
          "measuredParts": 9421,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "68.0 × 44.0 studs",
          "tippingMarginLdu": 434.11,
          "restingParts": 229,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 1439,
        "connectionCount": 1406,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 33,
        "disconnectedPartCount": 1288,
        "virtualColorCount": 0,
        "weakAttachmentCount": 748,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -116,
            0
          ],
          "max": [
            680,
            0,
            440
          ],
          "size": [
            680,
            116,
            440
          ]
        },
        "footprintStuds": [
          34,
          22
        ],
        "heightPlates": 14.5,
        "steps": 124,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "32 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 602.11,
          "massLabel": "602 g",
          "measuredParts": 1439,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "34.0 × 22.0 studs",
          "tippingMarginLdu": 214.74,
          "restingParts": 781,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 7982,
        "connectionsAdded": 10778,
        "componentsBefore": 33,
        "componentsAfter": 1,
        "loosePartsBefore": 1288,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 602.11,
        "massAfterGrams": 4645.69,
        "stepsBefore": 124,
        "stepsAfter": 101
      },
      "bill": [
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 6117
        },
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 2992
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 129
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 55
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 42
        },
        {
          "definitionId": "2445",
          "name": "Plate 2 x 12",
          "count": 22
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 22
        },
        {
          "definitionId": "4727",
          "name": "Plant, Flower 2 x 2 Leaves - Angular",
          "count": 10
        },
        {
          "definitionId": "4728",
          "name": "Plant, Flower 2 x 2 - Round [Open Stud]",
          "count": 10
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 10
        },
        {
          "definitionId": "32607",
          "name": "Plant, Plate 1 x 1 Round with 3 Leaves",
          "count": 4
        },
        {
          "definitionId": "6141",
          "name": "Plate Round 1 x 1 with Solid Stud",
          "count": 4
        }
      ],
      "distinctParts": 14,
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
      "id": "colossal-duck",
      "title": "Colossal Duck Float",
      "discipline": "Playful public art",
      "category": "creative",
      "tagline": "A giant yellow duck, orange bill and all, bobbing over a sixty-four-stud illuminated festival basin.",
      "summary": "A deliberately ridiculous public-art build at landmark scale: a round yellow body, oversized head, orange bill and black eye assembled from editable brick columns over a rippling blue festival basin.",
      "techniques": [
        "Large-scale comic sculpture",
        "Domed voxel body",
        "Graphic bill and eye accents",
        "Editable festival-water scene",
        "Festival lighting and shoreline trees"
      ],
      "showcase": null,
      "refinement": "The first float was a small yellow mass on loose one-layer water. The published version cross-bonds the whole basin and separates the body, head, bill and eyes into a clear, giant duck silhouette.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": {
        "prompt": "A funny large-scale yellow duck public-art float with a huge rounded body, tall head, orange bill and black eyes on an editable blue festival basin.",
        "envelopeStuds": [
          64,
          null,
          46
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
        "pitch": 46,
        "zoom": 1.08
      },
      "documentId": "demo_colossal_duck",
      "roughDocumentId": "demo_colossal_duck_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/colossal-duck/document.json",
          "bytes": 7572046,
          "sha256": "ca2d0b081809287f81df807508e2128312c898e99f00af9fd9f17ceb17ed6b3c",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/colossal-duck/rough.json",
          "bytes": 912426,
          "sha256": "69a68296a20f660dae7f18b43514e2b37b69216654bd590dd5200a775c34e6d2",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/colossal-duck/preview.json",
          "bytes": 537450,
          "sha256": "fceda9d7b20956a39acf61a91de27ff504dcca168e43d538e01dd9bca734a9b1",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/colossal-duck/rough-preview.json",
          "bytes": 82958,
          "sha256": "0c79e4866786c8fd2e3af8be9cabc6eacde5e0982c7b95915adae24573b73453",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/colossal-duck/thumb.png",
          "bytes": 45488,
          "sha256": "b671c1b65e9cdbc49cbce99ed8ba0839c3e3edadf2b59fc129bc387d8a59d880",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/colossal-duck/social.png",
          "bytes": 75874,
          "sha256": "333cdc20389360e0a948053424c3a523ed03966afd7170035d3f22a24981955f",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 10515,
        "connectionCount": 13221,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 17,
        "weakAttachmentCount": 2944,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -340,
            0
          ],
          "max": [
            1280,
            0,
            920
          ],
          "size": [
            1280,
            340,
            920
          ]
        },
        "footprintStuds": [
          64,
          46
        ],
        "heightPlates": 42.5,
        "steps": 112,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 5161.47,
          "massLabel": "5.16 kg",
          "measuredParts": 10515,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "64.0 × 46.0 studs",
          "tippingMarginLdu": 454.52,
          "restingParts": 238,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 1485,
        "connectionCount": 1449,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 36,
        "disconnectedPartCount": 1338,
        "virtualColorCount": 0,
        "weakAttachmentCount": 768,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -116,
            0
          ],
          "max": [
            640,
            0,
            480
          ],
          "size": [
            640,
            116,
            480
          ]
        },
        "footprintStuds": [
          32,
          24
        ],
        "heightPlates": 14.5,
        "steps": 139,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "35 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 620.89,
          "massLabel": "621 g",
          "measuredParts": 1485,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "32.0 × 24.0 studs",
          "tippingMarginLdu": 235.54,
          "restingParts": 804,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 9030,
        "connectionsAdded": 11772,
        "componentsBefore": 36,
        "componentsAfter": 1,
        "loosePartsBefore": 1338,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 620.89,
        "massAfterGrams": 5161.47,
        "stepsBefore": 139,
        "stepsAfter": 112
      },
      "bill": [
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 7265
        },
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 2945
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 135
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 49
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 46
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 22
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 22
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 8
        },
        {
          "definitionId": "6141",
          "name": "Plate Round 1 x 1 with Solid Stud",
          "count": 7
        },
        {
          "definitionId": "32607",
          "name": "Plant, Plate 1 x 1 Round with 3 Leaves",
          "count": 4
        },
        {
          "definitionId": "4727",
          "name": "Plant, Flower 2 x 2 Leaves - Angular",
          "count": 4
        },
        {
          "definitionId": "4728",
          "name": "Plant, Flower 2 x 2 - Round [Open Stud]",
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
      "id": "iron-lattice-lookout",
      "title": "Iron Lattice Lookout",
      "discipline": "Landmark ironwork",
      "category": "landmarks",
      "tagline": "Two tall tiers of open lattice rise from a landscaped civic garden to a clock stage and glazed lookout.",
      "summary": "An original ironwork lookout: an arched plinth, two lattice tiers of columns and bonded decks stepping inward, and a clock stage whose four hands each sit on a real revolute hinge. The lattice and the clock are built by the kernel’s own planners rather than drawn as solid walls with holes in them.",
      "techniques": [
        "Open lattice: columns between bonded decks",
        "Two tiers stepping inward",
        "Arched masonry plinth",
        "Four independently hinged clock hands",
        "Glazed observation pavilion and lit gardens"
      ],
      "showcase": null,
      "refinement": "The first candidate stood the ironwork straight on the open plinth, so the lower lattice deck rested on a one-stud wall rim and nothing else — most of that deck measures as unsupported. The published set caps the plinth with two cross-bonded plate layers before the tiers go on, which is what carries the tower.",
      "hero": false,
      "tensionAllowance": 320,
      "tensionReason": "Each lattice deck rests on the columns beneath it at their tops rather than clutching down into them, and the clock hands hang from their hinge knuckles. The statics pass counts both as tension-carried; the allowance is bounded so a genuinely unsupported deck still fails the gate.",
      "brief": {
        "prompt": "An ironwork lookout tower: an arched stone plinth, two tiers of open lattice stepping inward, and a clock stage near the top whose hands actually turn.",
        "envelopeStuds": [
          56,
          null,
          56
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
        "pitch": 24,
        "zoom": 1.06
      },
      "documentId": "demo_iron_lattice_lookout",
      "roughDocumentId": "demo_iron_lattice_lookout_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/iron-lattice-lookout/document.json",
          "bytes": 6875469,
          "sha256": "376776db15c1407744aac0d2c12d4ea5e51650f53a58e2365dd15ddd29ebde0e",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/iron-lattice-lookout/rough.json",
          "bytes": 659901,
          "sha256": "e19ea2c8802836f3da51fb1d4791f036ade9b37035c72f0c8f066aa0e4bfb158",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/iron-lattice-lookout/preview.json",
          "bytes": 254188,
          "sha256": "ceea95251cc1aae73a2e5784a42b7149db517b3f545d020dea0ffddcc7274b1d",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/iron-lattice-lookout/rough-preview.json",
          "bytes": 20344,
          "sha256": "39657292d3c1b0215483417c08f7e3edb72d773452af30b3455fd2188e9adf3d",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/iron-lattice-lookout/thumb.png",
          "bytes": 22253,
          "sha256": "8949c982da6bb9d042755ee4b8a0440c603a2c12aef394f9b5033138e0aca896",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/iron-lattice-lookout/social.png",
          "bytes": 38347,
          "sha256": "ecfb0cdcd24e9f4a92dfb90926d883fad816e3d7377d8af99f84dbebd4d8a4b4",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 4734,
        "connectionCount": 15522,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 124,
        "weakAttachmentCount": 1647,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -1204,
            0
          ],
          "max": [
            1120,
            0,
            1120
          ],
          "size": [
            1120,
            1204,
            1120
          ]
        },
        "footprintStuds": [
          56,
          56
        ],
        "heightPlates": 150.5,
        "steps": 77,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 4557.75,
          "massLabel": "4.56 kg",
          "measuredParts": 4734,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "56.0 × 56.0 studs",
          "tippingMarginLdu": 559.77,
          "restingParts": 232,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 62,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 325,
        "connectionCount": 1569,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 2,
        "disconnectedPartCount": 94,
        "virtualColorCount": 20,
        "weakAttachmentCount": 16,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -524,
            0
          ],
          "max": [
            320,
            0,
            320
          ],
          "size": [
            320,
            524,
            320
          ]
        },
        "footprintStuds": [
          16,
          16
        ],
        "heightPlates": 65.5,
        "steps": 7,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "1 part begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 454.16,
          "massLabel": "454 g",
          "measuredParts": 325,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "16.0 × 16.0 studs",
          "tippingMarginLdu": 156.35,
          "restingParts": 34,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 231,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 4409,
        "connectionsAdded": 13953,
        "componentsBefore": 2,
        "componentsAfter": 1,
        "loosePartsBefore": 94,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 231,
        "unsupportedAfter": 62,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 454.16,
        "massAfterGrams": 4557.75,
        "stepsBefore": 7,
        "stepsAfter": 77
      },
      "bill": [
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 2108
        },
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 1604
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 262
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 140
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 130
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 64
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 50
        },
        {
          "definitionId": "3022",
          "name": "Plate 2 x 2",
          "count": 43
        },
        {
          "definitionId": "3020",
          "name": "Plate 2 x 4",
          "count": 37
        },
        {
          "definitionId": "2445",
          "name": "Plate 2 x 12",
          "count": 36
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 32
        },
        {
          "definitionId": "91988",
          "name": "Plate 2 x 14",
          "count": 27
        }
      ],
      "distinctParts": 33,
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
      "id": "harbour-control-tower",
      "title": "Harbour Control Tower",
      "discipline": "Play set",
      "category": "architecture",
      "tagline": "An eighty-four-stud harbour district with drive-in bays, a metro platform, a glazed control shaft and a crane that luffs.",
      "summary": "An original quayside play set rather than another facade: two full-height vehicle bays cut through the podium, a metro platform along the seaward edge, a glazed control shaft with a control room on top, and a quay crane built by the kernel’s own planner on a real luffing hinge.",
      "techniques": [
        "Full-height drive-in vehicle bays",
        "Raised metro platform",
        "Glazed control shaft",
        "Crane on a real luffing hinge",
        "One subassembly per programme element",
        "Lit promenade, cargo court and warehouse planting"
      ],
      "showcase": null,
      "refinement": "The rough candidate was a single glazed block on a plain slab — a tower with nothing to do. The published set cuts the podium open for vehicles, raises a platform along the quay, and puts a crane on the roof that the joint solver can actually drive.",
      "hero": false,
      "tensionAllowance": 420,
      "tensionReason": "Glazing is seated inside its frames and the podium roof deck rests on the walls below it at the perimeter rather than clutching down into them. The statics pass counts both as tension-carried; the allowance is bounded so a genuinely unsupported deck still fails the gate.",
      "brief": {
        "prompt": "A quayside control tower with two drive-in vehicle bays under the podium, a metro platform along the water, a glazed control shaft with a control room on top, and a working crane on the podium roof.",
        "envelopeStuds": [
          84,
          null,
          56
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
          "Metro platform",
          "Luffing crane",
          "Verified build sequence"
        ]
      },
      "camera": {
        "yaw": 36,
        "pitch": 28,
        "zoom": 1.08
      },
      "documentId": "demo_harbour_control_tower",
      "roughDocumentId": "demo_harbour_control_tower_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/harbour-control-tower/document.json",
          "bytes": 9195647,
          "sha256": "39318a88d7db2bb641884b583cd5b109e8ddbd85566f3f3a1087d38084da4d62",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/harbour-control-tower/rough.json",
          "bytes": 1069235,
          "sha256": "58bae9ea31167c5e0ee821187faaf088729745976814ddea0ec1eb35d470fb0f",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/harbour-control-tower/preview.json",
          "bytes": 194498,
          "sha256": "d7dd38b0955464dd3f3db6481e7916679d43de5373e07abf98e67fbd220cba31",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/harbour-control-tower/rough-preview.json",
          "bytes": 21841,
          "sha256": "92a16bf6d5ff7fcea9763bcd0923cd5abc573f8660357b14273a6e0fa554c397",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/harbour-control-tower/thumb.png",
          "bytes": 23572,
          "sha256": "3058abbcdc7ada06b349bc8d34f8fcd0b276519d154ce10103e38c545114d9b9",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/harbour-control-tower/social.png",
          "bytes": 40396,
          "sha256": "915a85a5dad731885d97b98b40e6566c632ab1b5da290e04a5feaf6373a65a02",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 3564,
        "connectionCount": 22654,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 265,
        "weakAttachmentCount": 1685,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -1244,
            0
          ],
          "max": [
            1680,
            0,
            1120
          ],
          "size": [
            1680,
            1244,
            1120
          ]
        },
        "footprintStuds": [
          84,
          56
        ],
        "heightPlates": 155.5,
        "steps": 52,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 6588.4,
          "massLabel": "6.59 kg",
          "measuredParts": 3564,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "84.0 × 56.0 studs",
          "tippingMarginLdu": 476.65,
          "restingParts": 346,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 73,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 312,
        "connectionCount": 2674,
        "collisionCount": 5,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 25,
        "weakAttachmentCount": 18,
        "healthy": false,
        "boundsLdu": {
          "min": [
            0,
            -436,
            0
          ],
          "max": [
            560,
            0,
            400
          ],
          "size": [
            560,
            436,
            400
          ]
        },
        "footprintStuds": [
          28,
          20
        ],
        "heightPlates": 54.5,
        "steps": 8,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "Step 7 adds part_0236 into a pose already enclosed by part_0154, part_0162 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 7 adds part_0237 into a pose already enclosed by part_0154, part_0163 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 773.57,
          "massLabel": "774 g",
          "measuredParts": 312,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "28.0 × 20.0 studs",
          "tippingMarginLdu": 197.72,
          "restingParts": 63,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 7,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 3252,
        "connectionsAdded": 19980,
        "componentsBefore": 1,
        "componentsAfter": 1,
        "loosePartsBefore": 0,
        "loosePartsAfter": 0,
        "collisionsBefore": 5,
        "collisionsAfter": 0,
        "unsupportedBefore": 7,
        "unsupportedAfter": 73,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 773.57,
        "massAfterGrams": 6588.4,
        "stepsBefore": 8,
        "stepsAfter": 52
      },
      "bill": [
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 1632
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 426
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 269
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 227
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 200
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 156
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 84
        },
        {
          "definitionId": "6111",
          "name": "Brick 1 x 10",
          "count": 78
        },
        {
          "definitionId": "2445",
          "name": "Plate 2 x 12",
          "count": 66
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 66
        },
        {
          "definitionId": "60593",
          "name": "Window 1 x 2 x 3 Flat Front",
          "count": 60
        },
        {
          "definitionId": "2465",
          "name": "Brick 1 x 16",
          "count": 56
        }
      ],
      "distinctParts": 32,
      "planWarnings": [
        "No door frame 6 studs wide is compiled in this build, so that opening is a bare hole.",
        "No door frame 6 studs wide is compiled in this build, so that opening is a bare hole.",
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
      "id": "saucer-freighter",
      "title": "Saucer Freighter",
      "discipline": "Vehicle and mechanism",
      "category": "vehicles",
      "tagline": "A faceted lozenge hull on a seventy-stud illuminated dock, with twin booms, a turning turret and opening ramp.",
      "summary": "An original freighter: a cross-bonded keel, a sideways-stud hull skin built by the kernel’s own SNOT planner, twin booms flanking a centred cockpit, and two real hinges — a dorsal turret and a boarding ramp — that the joint solver drives in the editor.",
      "techniques": [
        "Sideways-stud hull skin (SNOT)",
        "Stepped lozenge planform",
        "Twin booms, centred cockpit",
        "Hinged boarding ramp",
        "Hinged dorsal turret",
        "Illuminated shipyard apron and hull ribs"
      ],
      "showcase": null,
      "refinement": "The rough candidate was a single rectangular slab with the cockpit sitting on top of it — a box with a windscreen. The published set steps the hull in at bow and stern, wraps it in a genuinely clutched sideways skin, and replaces the moulded-on details with two hinges the kernel can actually drive.",
      "hero": false,
      "tensionAllowance": 640,
      "tensionReason": "The sideways skins hang from side-facing studs on the rim brackets and the hinged flaps rest on their knuckles rather than clutching down into the deck. The raised inner deck also spans the four cross-bonded keel bands instead of being packed solid underneath. The statics pass counts these as tension-carried; the allowance is bounded so an actually unsupported panel still fails the gate.",
      "brief": {
        "prompt": "An original saucer freighter with a stepped lozenge hull, sideways-stud skins, twin forward booms either side of a centred cockpit, a dorsal turret that turns and a boarding ramp that opens.",
        "envelopeStuds": [
          70,
          null,
          56
        ],
        "palette": [
          "Light Bluish Grey",
          "Dark Bluish Grey",
          "Dark Tan"
        ],
        "functions": [
          "Hinged boarding ramp",
          "Hinged dorsal turret",
          "Sideways-stud hull skin"
        ]
      },
      "camera": {
        "yaw": 42,
        "pitch": 30,
        "zoom": 1.08
      },
      "documentId": "demo_saucer_freighter",
      "roughDocumentId": "demo_saucer_freighter_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/saucer-freighter/document.json",
          "bytes": 7113202,
          "sha256": "ed834ba83f21bfdaadfd29747fe45ec01d2266b96ef6fd49476e3bb419509293",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/saucer-freighter/rough.json",
          "bytes": 536551,
          "sha256": "4ded0b2d4aaec5d1ddc8284c6a9644845bf34bf7166eae2575fd92130917e0fa",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/saucer-freighter/preview.json",
          "bytes": 276515,
          "sha256": "d7274a17f6372c3a3e8c6b02394bc2fb241b31e64fee9bc5fad2d7a3c9db5ac2",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/saucer-freighter/rough-preview.json",
          "bytes": 15305,
          "sha256": "cae9a32a14fec6d97a17ffc9c515b2b70b0ef1c57ac49e8a01a824948fa1e083",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/saucer-freighter/thumb.png",
          "bytes": 46258,
          "sha256": "c1a10b67da2080279ae45e19affc358fcd625498d68ba8ca2f29d60adc6d1c46",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/saucer-freighter/social.png",
          "bytes": 81637,
          "sha256": "843768079930086f316d70c2acf3a2c96125878ccbcf5e86977cbc7d41514feb",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 5350,
        "connectionCount": 16000,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 4,
        "weakAttachmentCount": 1755,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -212,
            0
          ],
          "max": [
            1400,
            0,
            1120
          ],
          "size": [
            1400,
            212,
            1120
          ]
        },
        "footprintStuds": [
          70,
          56
        ],
        "heightPlates": 26.5,
        "steps": 90,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 4017.05,
          "massLabel": "4.02 kg",
          "measuredParts": 5350,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "70.0 × 56.0 studs",
          "tippingMarginLdu": 559.72,
          "restingParts": 289,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 462,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 229,
        "connectionCount": 1299,
        "collisionCount": 34,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 2,
        "weakAttachmentCount": 66,
        "healthy": false,
        "boundsLdu": {
          "min": [
            0,
            -180,
            0
          ],
          "max": [
            360,
            0,
            280
          ],
          "size": [
            360,
            180,
            280
          ]
        },
        "footprintStuds": [
          18,
          14
        ],
        "heightPlates": 22.5,
        "steps": 11,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "Step 6 adds part_0202 into a pose already enclosed by part_0049, part_0131 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 6 adds part_0203 into a pose already enclosed by part_0049, part_0131 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0186 into a pose already enclosed by part_0172, part_0037 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0185 into a pose already enclosed by part_0160, part_0049 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0188 into a pose already enclosed by part_0174, part_0049 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0187 into a pose already enclosed by part_0163, part_0049 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0189 into a pose already enclosed by part_0175, part_0051 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0190 into a pose already enclosed by part_0166, part_0177 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0193 into a pose already enclosed by part_0183, part_0182 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0196 into a pose already enclosed by part_0177, part_0166. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0199 into a pose already enclosed by part_0147, part_0177 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0197 into a pose already enclosed by part_0167, part_0178. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0191 into a pose already enclosed by part_0167, part_0177 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0206 into a pose already enclosed by part_0172, part_0127 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0205 into a pose already enclosed by part_0160, part_0129 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0208 into a pose already enclosed by part_0174, part_0127 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0207 into a pose already enclosed by part_0163, part_0131 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0209 into a pose already enclosed by part_0175, part_0125 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0210 into a pose already enclosed by part_0166, part_0131 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0213 into a pose already enclosed by part_0181, part_0125 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0219 into a pose already enclosed by part_0177, part_0127 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 313.32,
          "massLabel": "313 g",
          "measuredParts": 229,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "18.0 × 14.0 studs",
          "tippingMarginLdu": 138.47,
          "restingParts": 28,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 48,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 5121,
        "connectionsAdded": 14701,
        "componentsBefore": 1,
        "componentsAfter": 1,
        "loosePartsBefore": 0,
        "loosePartsAfter": 0,
        "collisionsBefore": 34,
        "collisionsAfter": 0,
        "unsupportedBefore": 48,
        "unsupportedAfter": 462,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 313.32,
        "massAfterGrams": 4017.05,
        "stepsBefore": 11,
        "stepsAfter": 90
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 4168
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 241
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 174
        },
        {
          "definitionId": "87087",
          "name": "Brick Special 1 x 1 with Stud on 1 Side",
          "count": 124
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 113
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 75
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 68
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 56
        },
        {
          "definitionId": "3020",
          "name": "Plate 2 x 4",
          "count": 50
        },
        {
          "definitionId": "6141",
          "name": "Plate Round 1 x 1 with Solid Stud",
          "count": 50
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 44
        },
        {
          "definitionId": "91988",
          "name": "Plate 2 x 14",
          "count": 28
        }
      ],
      "distinctParts": 25,
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
      "id": "harbour-street",
      "title": "Harbour Street",
      "discipline": "Modular architecture",
      "category": "architecture",
      "tagline": "Seven four-storey shopfronts, separated by alleys and finished with roof rooms, trees, lights and planted entries.",
      "summary": "Seven four-storey shopfronts on a full street district. Every address lifts out, every floor lifts off, and the public realm is built at the same editable grain.",
      "techniques": [
        "One subassembly per storey, per unit",
        "Tiled carriageway, kerb and pavement",
        "Seated shopfront doors and glazing",
        "Parapet roofline",
        "Two-stud alleys and individual roof rooms",
        "Street trees, lamps and planted thresholds"
      ],
      "showcase": null,
      "refinement": "The first candidate laid the terrace as one continuous shell on a painted ground plane, so nothing came apart and the street was a texture. The published set separates every unit and every floor, and lays the road surface as individual tiles.",
      "hero": false,
      "tensionAllowance": 480,
      "tensionReason": "Glazing is seated inside its frames and each storey deck rests on the walls below it at the perimeter rather than clutching down into them. The statics pass counts both as tension-carried; the allowance is bounded so a genuinely unsupported storey still fails.",
      "brief": {
        "prompt": "A street of seven four-storey modular shops with flats above, separate alleys, detailed roofs, trees, lights and planted thresholds, where every building and every floor can be lifted off separately.",
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
          "bytes": 12897875,
          "sha256": "c753812d947931f6537a75e360641af758a233a9b97d711ff0fa35bb19134856",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/harbour-street/rough.json",
          "bytes": 1219283,
          "sha256": "8bb7807b951608d07fce50505d198627a657b742082a436240c4be810bc0e891",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/harbour-street/preview.json",
          "bytes": 430953,
          "sha256": "dfe17dfa1eda5276843e38588546c5ca72a39a0723473d9f713e2ff37ec53019",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/harbour-street/rough-preview.json",
          "bytes": 60679,
          "sha256": "256a885b13dc0b6d8ce5deb4b387170d3ca7bad67baa86fdc0122d6be22f6818",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/harbour-street/thumb.png",
          "bytes": 40544,
          "sha256": "d8f91a680d78f7cc79e715bc08de8658a56e6413489a0c1199ca8b6889737e36",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/harbour-street/social.png",
          "bytes": 67118,
          "sha256": "8dc607ff57cb656c51fa61983e5d8697e392e2e58844e701db5b7b2bde09fed6",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 7913,
        "connectionCount": 29204,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 38,
        "weakAttachmentCount": 4735,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -628,
            0
          ],
          "max": [
            2680,
            0,
            1000
          ],
          "size": [
            2680,
            628,
            1000
          ]
        },
        "footprintStuds": [
          134,
          50
        ],
        "heightPlates": 78.5,
        "steps": 114,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 9562.91,
          "massLabel": "9.56 kg",
          "measuredParts": 7913,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "134.0 × 50.0 studs",
          "tippingMarginLdu": 385.89,
          "restingParts": 466,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 154,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 1095,
        "connectionCount": 2496,
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
          "massGrams": 979.63,
          "massLabel": "980 g",
          "measuredParts": 1095,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "34.0 × 34.0 studs",
          "tippingMarginLdu": 278.54,
          "restingParts": 763,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 16,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 6818,
        "connectionsAdded": 26708,
        "componentsBefore": 34,
        "componentsAfter": 1,
        "loosePartsBefore": 673,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 16,
        "unsupportedAfter": 154,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 979.63,
        "massAfterGrams": 9562.91,
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
          "count": 560
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
          "count": 252
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 238
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 231
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 220
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 168
        },
        {
          "definitionId": "60592",
          "name": "Window 1 x 2 x 2 Flat Front",
          "count": 154
        },
        {
          "definitionId": "60601",
          "name": "Glass for Window 1 x 2 x 2 Flat",
          "count": 154
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 140
        }
      ],
      "distinctParts": 28,
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
      "tagline": "A twenty-eight-storey modular high-rise with two setbacks, a complete civic plaza and real seated glazing.",
      "summary": "Twenty-eight storeys, each its own subassembly, step through three distinct tower volumes above a landscaped plaza, pavilion and reflecting pool.",
      "techniques": [
        "One subassembly per storey",
        "Cross-bonded deck between floors",
        "Seated window frames on every elevation",
        "Stepped crown and mast",
        "Two structural setbacks",
        "Landscaped plaza, pavilion and reflecting pool"
      ],
      "showcase": null,
      "refinement": "The massing study stacked the storeys as one continuous shell, so there was no seam to lift and the facades were blank. The published set separates every floor onto its own two-layer deck and glazes the elevations with frames the catalogue actually compiles.",
      "hero": false,
      "tensionAllowance": 1100,
      "tensionReason": "Two things in this model are held in bearing rather than in clutch, and the statics pass counts both as tension-carried. The glazing is seated inside its frames, and the middle of each storey deck rests on the walls below it at the perimeter rather than clutching down into them. The two setback transfer decks use the same bearing condition. All three are how a modular building is actually assembled; the allowance is bounded so a genuinely floating storey still fails the gate.",
      "brief": {
        "prompt": "A twenty-eight-storey modular tower on a landscaped plaza, where every floor lifts off separately, the elevations carry real windows, two upper volumes set back, and the crown rises to a mast.",
        "envelopeStuds": [
          84,
          null,
          52
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
        "pitch": 20,
        "zoom": 1.1
      },
      "documentId": "demo_meridian_tower",
      "roughDocumentId": "demo_meridian_tower_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/meridian-tower/document.json",
          "bytes": 19987512,
          "sha256": "715c19719bb9fe2a0e323a4a7bc89191c05ddd82f279f787d1f299ae43d8e9b6",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/meridian-tower/rough.json",
          "bytes": 3309405,
          "sha256": "fabdd0d015c2cdbfa9092ae56628a1bda0156448ca463c31d2ff72b31b1aed0a",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/meridian-tower/preview.json",
          "bytes": 496275,
          "sha256": "407e4c29a9434438ce13616d5108ae5dc15820aac7c2aabb3af9f85aabfe7384",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/meridian-tower/rough-preview.json",
          "bytes": 116942,
          "sha256": "80475383cf9d1dec69ce583811d537d8f4438c2ae20ed1ff17e4bc44139f2387",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/meridian-tower/thumb.png",
          "bytes": 16938,
          "sha256": "5e4efe53d5906f2c81a42d7df07b1c1c1d11a64db62ab3e0ddb56abf4663437e",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/meridian-tower/social.png",
          "bytes": 27704,
          "sha256": "bb72d51716af77b6f3765d8fec8e3a4122746d8690a5de37297c7acd1c0786cc",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 8895,
        "connectionCount": 47385,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 154,
        "weakAttachmentCount": 3854,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -4244,
            0
          ],
          "max": [
            1680,
            0,
            1040
          ],
          "size": [
            1680,
            4244,
            1040
          ]
        },
        "footprintStuds": [
          84,
          52
        ],
        "heightPlates": 530.5,
        "steps": 136,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 16180.55,
          "massLabel": "16.18 kg",
          "measuredParts": 8895,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "84.0 × 52.0 studs",
          "tippingMarginLdu": 519.98,
          "restingParts": 322,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 855,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 2134,
        "connectionCount": 7382,
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
          "massGrams": 2708.15,
          "massLabel": "2.71 kg",
          "measuredParts": 2134,
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
        "partsAdded": 6761,
        "connectionsAdded": 40003,
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
        "massBeforeGrams": 2708.15,
        "massAfterGrams": 16180.55,
        "stepsBefore": 69,
        "stepsAfter": 136
      },
      "bill": [
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 3324
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 955
        },
        {
          "definitionId": "3622",
          "name": "Brick 1 x 3",
          "count": 936
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 488
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
          "definitionId": "2465",
          "name": "Brick 1 x 16",
          "count": 352
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 351
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 246
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 174
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 158
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 128
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
      "summary": "A display-scale UIUC campus set anchored by the Illini Union and Foellinger Auditorium, with Altgeld Hall, Alma Mater, six flanking academic blocks, the Main Quad path geometry, Morrow Plots, mature trees and brick-built students, an east visitor hall and a south garden pavilion. The site finish alone is 11,264 individually editable pieces over a cross-bonded base.",
      "techniques": [
        "10,000+ catalog-backed pieces",
        "Cross-bonded 128 × 88-stud foundation",
        "Nine landmark structures",
        "Stepped copper dome and bell tower",
        "18 campus figures",
        "Three-figure Alma Mater group",
        "Twenty-eight mature trees and sixteen path lights"
      ],
      "showcase": {
        "landmarkCount": 9,
        "characterCount": 21,
        "siteFinishParts": 11264
      },
      "refinement": "The massing study established the Main Quad axis on a one-layer field, but its plate runs were disconnected. The published set cross-bonds the entire site, replaces the massing blocks with detailed landmark buildings, and adds the 11,264-piece landscape, characters and buildable campus life.",
      "hero": true,
      "tensionAllowance": 256,
      "tensionReason": "Window panes are seated inside their frames rather than carried in vertical compression. The statics pass counts those glazed inserts as tension-carried, measures their mass, and still checks every attachment group against the conservative clutch assumption.",
      "brief": {
        "prompt": "Build a display-scale replica of the University of Illinois Main Quad with the Union and Foellinger on axis, Altgeld and Alma Mater, academic halls, Morrow Plots, trees, paths, and enough students to make it feel alive. It must exceed ten thousand real pieces and still pass the physical kernel.",
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
          "bytes": 15235519,
          "sha256": "e4e981f8a7aeb2635df784006517256651691da690d132e5b2d6b3820be4c5aa",
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
          "bytes": 746174,
          "sha256": "e418b5f495c3e81c4ca8aaa82f1820de14a7f90c94664577d5545aedc708ba76",
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
          "bytes": 48246,
          "sha256": "40daec906142c4bc36625017225cc2da7f3305e9abb5cd5882980fdbd00a8001",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/illinois-main-quad/social.png",
          "bytes": 89084,
          "sha256": "f5f6e89f8d68c994e8739aec59de07e53afd4905fba9bc897ef4a76a6bc8355a",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 13844,
        "connectionCount": 32172,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 99,
        "weakAttachmentCount": 10636,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -404,
            0
          ],
          "max": [
            2560,
            0,
            1760
          ],
          "size": [
            2560,
            404,
            1760
          ]
        },
        "footprintStuds": [
          128,
          88
        ],
        "heightPlates": 50.5,
        "steps": 221,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 9747.06,
          "massLabel": "9.75 kg",
          "measuredParts": 13844,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "128.0 × 88.0 studs",
          "tippingMarginLdu": 843.9,
          "restingParts": 807,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 68,
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
        "partsAdded": 13418,
        "connectionsAdded": 31256,
        "componentsBefore": 206,
        "componentsAfter": 1,
        "loosePartsBefore": 352,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 68,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 2075.86,
        "massAfterGrams": 9747.06,
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
          "count": 643
        },
        {
          "definitionId": "3062b",
          "name": "Brick Round 1 x 1 Open Stud",
          "count": 282
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 278
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 174
        },
        {
          "definitionId": "3622",
          "name": "Brick 1 x 3",
          "count": 148
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 106
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 104
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 74
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 72
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 70
        }
      ],
      "distinctParts": 38,
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
