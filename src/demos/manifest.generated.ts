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
      "tagline": "A sixty-four-stud blue whale with fins, flukes and foam rising from an editable ocean mosaic.",
      "summary": "A display-scale whale built as hundreds of individually editable stud columns over a fully tiled ocean scene. The body swells in measured brick courses, the flukes spread across the water, and a white eye-and-foam pass keeps the silhouette readable from every orbit.",
      "techniques": [
        "Voxel-sculpted animal anatomy",
        "Cross-bonded 64 x 30-stud plinth",
        "Editable ocean mosaic",
        "Layered fins and flukes"
      ],
      "showcase": null,
      "refinement": "The first candidate put a simplified whale on a one-layer plate field whose parallel runs stayed disconnected. The published monument cross-bonds the complete ocean plinth and expands the body, fins, flukes and surface detail.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": {
        "prompt": "A large brick-built blue whale monument with a readable body, broad flukes, side fins and white foam, mounted over an editable ocean mosaic.",
        "envelopeStuds": [
          64,
          null,
          30
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
        "zoom": 1.02
      },
      "documentId": "demo_blue_whale_monument",
      "roughDocumentId": "demo_blue_whale_monument_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/blue-whale-monument/document.json",
          "bytes": 4726969,
          "sha256": "47087ef0f2eb19f6bd78325e17065f2baf142a0846a11797565f2c555c10c127",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/blue-whale-monument/rough.json",
          "bytes": 1351835,
          "sha256": "acc4a040913936d159fab89cd19ce9dfa9bbbe3c01665e5a0c5e2bfd08a43392",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/blue-whale-monument/preview.json",
          "bytes": 331427,
          "sha256": "76d07d26f418eaf0b0e8dad1cebca844f063c0be88869ddaf1a5897d1d7d6f4f",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/blue-whale-monument/rough-preview.json",
          "bytes": 119818,
          "sha256": "91563fc0b6076a9de8798d3d0461ac7bb8894254cc1f88b09968f47d6dcdcc42",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/blue-whale-monument/thumb.png",
          "bytes": 33247,
          "sha256": "5bc84260544ae5c09dd1a190c6181b0a96e5ebab5df7e5dbcbbd685868f2298a",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/blue-whale-monument/social.png",
          "bytes": 64265,
          "sha256": "d26bbe28746ab49dafef805125e1e7d0b9173cb1fe79906563c75bf5b636fd2e",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 6534,
        "connectionCount": 8296,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 0,
        "weakAttachmentCount": 1920,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -220,
            0
          ],
          "max": [
            1280,
            0,
            600
          ],
          "size": [
            1280,
            220,
            600
          ]
        },
        "footprintStuds": [
          64,
          30
        ],
        "heightPlates": 27.5,
        "steps": 69,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 3216.58,
          "massLabel": "3.22 kg",
          "measuredParts": 6534,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "64.0 × 30.0 studs",
          "tippingMarginLdu": 293.33,
          "restingParts": 158,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 2179,
        "connectionCount": 2140,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 39,
        "disconnectedPartCount": 2031,
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
        "steps": 184,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "38 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 937.73,
          "massLabel": "938 g",
          "measuredParts": 2179,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "42.0 × 22.0 studs",
          "tippingMarginLdu": 213.76,
          "restingParts": 963,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 4355,
        "connectionsAdded": 6156,
        "componentsBefore": 39,
        "componentsAfter": 1,
        "loosePartsBefore": 2031,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 937.73,
        "massAfterGrams": 3216.58,
        "stepsBefore": 184,
        "stepsAfter": 69
      },
      "bill": [
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 4456
        },
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 1921
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 87
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 30
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 14
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 14
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 8
        },
        {
          "definitionId": "4477",
          "name": "Plate 1 x 10",
          "count": 2
        },
        {
          "definitionId": "3666",
          "name": "Plate 1 x 6",
          "count": 1
        },
        {
          "definitionId": "78329",
          "name": "Plate 1 x 5",
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
      "id": "sunline-suspension-bridge",
      "title": "Sunline Suspension Bridge",
      "discipline": "Landmark infrastructure",
      "category": "landmarks",
      "tagline": "Twin brick-red gateways carry a road and stepped golden hangers across a ninety-two-stud river.",
      "summary": "An original city landmark on a fully editable river: a cross-bonded road deck, twin twelve-course gateway towers, smooth traffic lanes and honest stud-connected hanger columns tracing the suspension profile on both edges.",
      "techniques": [
        "92 x 34-stud river scene",
        "Twin masonry gateway towers",
        "Cross-bonded suspended deck",
        "Stepped catenary hangers"
      ],
      "showcase": null,
      "refinement": "The first candidate stopped at a one-layer river study, leaving its plate runs disconnected and no crossing between the banks. The published build cross-bonds the river, adds the complete road deck, towers, lanes and two lines of suspension hangers.",
      "hero": false,
      "tensionAllowance": 320,
      "tensionReason": "The bonded tower caps rest on perimeter masonry and the statics pass counts their interior plates as tension-carried. The allowance is bounded so a floating deck or tower still fails.",
      "brief": {
        "prompt": "An original large suspension bridge with twin brick-red gateway towers, a long road deck, golden vertical hangers and a fully editable river beneath it.",
        "envelopeStuds": [
          92,
          null,
          34
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
        "zoom": 0.98
      },
      "documentId": "demo_sunline_suspension_bridge",
      "roughDocumentId": "demo_sunline_suspension_bridge_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/sunline-suspension-bridge/document.json",
          "bytes": 4386516,
          "sha256": "c0afaf0a8e2829169156114fd6685b06c388f3e51ef50a939b1e024dcafb14f6",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/sunline-suspension-bridge/rough.json",
          "bytes": 756337,
          "sha256": "e7640d4750a3c3c1411c69886daf2a17e724d30fb620b28cb1ec266042d6051f",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/sunline-suspension-bridge/preview.json",
          "bytes": 227768,
          "sha256": "019a5b3360a5a4fc9fbab84129d7d784d204129986195ef582678af8f0478222",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/sunline-suspension-bridge/rough-preview.json",
          "bytes": 71059,
          "sha256": "1f948c636d9e4ba87a2fad711c5ff0c8e03bf7cdc706d6f4fb6537ce4db36ec0",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/sunline-suspension-bridge/thumb.png",
          "bytes": 38376,
          "sha256": "c6db1d1bdaa5bda0443dd6652404d6c1e70798c6647051736b009fbe4c2ad87e",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/sunline-suspension-bridge/social.png",
          "bytes": 65837,
          "sha256": "b4845e63cfe25fe3c177022d87061c9ac149c25dfba3176c14f81288c39803c1",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 4295,
        "connectionCount": 9170,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 0,
        "weakAttachmentCount": 2954,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -348,
            0
          ],
          "max": [
            1840,
            0,
            680
          ],
          "size": [
            1840,
            348,
            680
          ]
        },
        "footprintStuds": [
          92,
          34
        ],
        "heightPlates": 43.5,
        "steps": 46,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 2564.41,
          "massLabel": "2.56 kg",
          "measuredParts": 4295,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "92.0 × 34.0 studs",
          "tippingMarginLdu": 339.94,
          "restingParts": 249,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 8,
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
        "partsAdded": 3019,
        "connectionsAdded": 7938,
        "componentsBefore": 44,
        "componentsAfter": 1,
        "loosePartsBefore": 1243,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 8,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 469.8,
        "massAfterGrams": 2564.41,
        "stepsBefore": 131,
        "stepsAfter": 46
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 3128
        },
        {
          "definitionId": "3070b",
          "name": "Tile 1 x 1 with Groove",
          "count": 408
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 282
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 193
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 48
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 48
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 26
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 25
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 25
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 24
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 24
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 19
        }
      ],
      "distinctParts": 18,
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
        "Editable canyon mosaic"
      ],
      "showcase": null,
      "refinement": "The first candidate used a smaller silhouette over loose plate runs. The published figure cross-bonds a fifty-stud scene and resolves the mammoth into a fuller body, grounded legs, ears, trunk and paired tusks.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": {
        "prompt": "A large brick-built woolly mammoth with a massive rounded body, four grounded legs, a lowered trunk, amber ears and white tusks on a canyon display plinth.",
        "envelopeStuds": [
          50,
          null,
          32
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
        "zoom": 1.04
      },
      "documentId": "demo_copper_mammoth",
      "roughDocumentId": "demo_copper_mammoth_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/copper-mammoth/document.json",
          "bytes": 3307721,
          "sha256": "f687d93912cfc89f1e54d778c3749982075adc1859a6fb0b65bfeec6c20c8fb3",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/copper-mammoth/rough.json",
          "bytes": 928921,
          "sha256": "a4b564d4f8f607f853517fd70d52b770580d95398f3413d4f83b2d0eebf5a1a5",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/copper-mammoth/preview.json",
          "bytes": 224783,
          "sha256": "e6cc25de38a1421441dca8dd69a569cea333a2bc24dec462c30c9539b014a7fe",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/copper-mammoth/rough-preview.json",
          "bytes": 83056,
          "sha256": "8aa951f3dc3eba49c4fa08eb274427ab4cfafb69ad7ae968d2b357cf6db819f8",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/copper-mammoth/thumb.png",
          "bytes": 32437,
          "sha256": "f0c0622c6a90a19b9e4943c853e90ba8b56f266785f2d12d8e9fc6c2203dcc94",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/copper-mammoth/social.png",
          "bytes": 65998,
          "sha256": "1501b49b619e4a2001017cc831fb21e98a62eb0b0a2d9cb44b64fe6db9db36d2",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 4458,
        "connectionCount": 5924,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 0,
        "weakAttachmentCount": 1600,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -220,
            0
          ],
          "max": [
            1000,
            0,
            640
          ],
          "size": [
            1000,
            220,
            640
          ]
        },
        "footprintStuds": [
          50,
          32
        ],
        "heightPlates": 27.5,
        "steps": 48,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 2204.36,
          "massLabel": "2.20 kg",
          "measuredParts": 4458,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "50.0 × 32.0 studs",
          "tippingMarginLdu": 314.05,
          "restingParts": 134,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 1508,
        "connectionCount": 1475,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 33,
        "disconnectedPartCount": 1356,
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
        "steps": 128,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "32 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 635.31,
          "massLabel": "635 g",
          "measuredParts": 1508,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "34.0 × 22.0 studs",
          "tippingMarginLdu": 214.49,
          "restingParts": 781,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 2950,
        "connectionsAdded": 4449,
        "componentsBefore": 33,
        "componentsAfter": 1,
        "loosePartsBefore": 1356,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 635.31,
        "massAfterGrams": 2204.36,
        "stepsBefore": 128,
        "stepsAfter": 48
      },
      "bill": [
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 2724
        },
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 1600
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 62
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 31
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 31
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 6
        },
        {
          "definitionId": "3460",
          "name": "Plate 1 x 8",
          "count": 2
        },
        {
          "definitionId": "3666",
          "name": "Plate 1 x 6",
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
      "id": "colossal-duck",
      "title": "Colossal Duck Float",
      "discipline": "Playful public art",
      "category": "creative",
      "tagline": "A giant yellow duck, orange bill and all, bobbing over a forty-six-stud festival-water mosaic.",
      "summary": "A deliberately ridiculous public-art build at landmark scale: a round yellow body, oversized head, orange bill and black eye assembled from editable brick columns over a rippling blue festival basin.",
      "techniques": [
        "Large-scale comic sculpture",
        "Domed voxel body",
        "Graphic bill and eye accents",
        "Editable festival-water scene"
      ],
      "showcase": null,
      "refinement": "The first float was a small yellow mass on loose one-layer water. The published version cross-bonds the whole basin and separates the body, head, bill and eyes into a clear, giant duck silhouette.",
      "hero": false,
      "tensionAllowance": 0,
      "tensionReason": null,
      "brief": {
        "prompt": "A funny large-scale yellow duck public-art float with a huge rounded body, tall head, orange bill and black eyes on an editable blue festival basin.",
        "envelopeStuds": [
          46,
          null,
          34
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
        "zoom": 1.02
      },
      "documentId": "demo_colossal_duck",
      "roughDocumentId": "demo_colossal_duck_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/colossal-duck/document.json",
          "bytes": 3622649,
          "sha256": "560a73d5367807f18ace70454abf79a4c0a984877bc7321bf4c757151063f9da",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/colossal-duck/rough.json",
          "bytes": 984780,
          "sha256": "98e4e45b8ebdb456ec400f23a7cfccdbd5c20121602992c07d9a821c497c7b1b",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/colossal-duck/preview.json",
          "bytes": 255265,
          "sha256": "2b5c6bc65503ec6735594ce5b3044516620fc57e386a8063d53d7535767bdc05",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/colossal-duck/rough-preview.json",
          "bytes": 88632,
          "sha256": "5964d981f256a416b537d38e57c6e5b761cd1d8d8d6e8ab2911019acf7de80e9",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/colossal-duck/thumb.png",
          "bytes": 35219,
          "sha256": "ec87a76b5b69067762413bebd153f8c8c2fdf663704afa75c142e1426d7c015d",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/colossal-duck/social.png",
          "bytes": 61291,
          "sha256": "ca1cf6b0bbe444e2741a18635b32ac9bd03bad35e513f9722f325ca6186cd967",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 4975,
        "connectionCount": 6397,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 8,
        "weakAttachmentCount": 1564,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -244,
            0
          ],
          "max": [
            920,
            0,
            680
          ],
          "size": [
            920,
            244,
            680
          ]
        },
        "footprintStuds": [
          46,
          34
        ],
        "heightPlates": 30.5,
        "steps": 55,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 2446.79,
          "massLabel": "2.45 kg",
          "measuredParts": 4975,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "46.0 × 34.0 studs",
          "tippingMarginLdu": 333.57,
          "restingParts": 142,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 1598,
        "connectionCount": 1562,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 36,
        "disconnectedPartCount": 1447,
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
        "steps": 141,
        "buildOrderVerified": false,
        "buildOrderWarnings": [
          "35 parts begin a new independent island: they attach to nothing placed earlier, so each starts a separately-built subassembly."
        ],
        "statics": {
          "massGrams": 675.27,
          "massLabel": "675 g",
          "measuredParts": 1598,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "32.0 × 24.0 studs",
          "tippingMarginLdu": 235.05,
          "restingParts": 804,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 0,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 3377,
        "connectionsAdded": 4835,
        "componentsBefore": 36,
        "componentsAfter": 1,
        "loosePartsBefore": 1447,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 0,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 675.27,
        "massAfterGrams": 2446.79,
        "stepsBefore": 141,
        "stepsAfter": 55
      },
      "bill": [
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 3269
        },
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 1564
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 66
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 17
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 17
        },
        {
          "definitionId": "3020",
          "name": "Plate 2 x 4",
          "count": 16
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 16
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 6
        },
        {
          "definitionId": "78329",
          "name": "Plate 1 x 5",
          "count": 2
        },
        {
          "definitionId": "3666",
          "name": "Plate 1 x 6",
          "count": 1
        },
        {
          "definitionId": "3710",
          "name": "Plate 1 x 4",
          "count": 1
        }
      ],
      "distinctParts": 11,
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
      "tagline": "Two tiers of open lattice over an arched masonry plinth, topped by a clock stage with four hinged hands.",
      "summary": "An original ironwork lookout: an arched plinth, two lattice tiers of columns and bonded decks stepping inward, and a clock stage whose four hands each sit on a real revolute hinge. The lattice and the clock are built by the kernel’s own planners rather than drawn as solid walls with holes in them.",
      "techniques": [
        "Open lattice: columns between bonded decks",
        "Two tiers stepping inward",
        "Arched masonry plinth",
        "Four independently hinged clock hands"
      ],
      "showcase": null,
      "refinement": "The first candidate stood the ironwork straight on the open plinth, so the lower lattice deck rested on a one-stud wall rim and nothing else — most of that deck measures as unsupported. The published set caps the plinth with two cross-bonded plate layers before the tiers go on, which is what carries the tower.",
      "hero": false,
      "tensionAllowance": 320,
      "tensionReason": "Each lattice deck rests on the columns beneath it at their tops rather than clutching down into them, and the clock hands hang from their hinge knuckles. The statics pass counts both as tension-carried; the allowance is bounded so a genuinely unsupported deck still fails the gate.",
      "brief": {
        "prompt": "An ironwork lookout tower: an arched stone plinth, two tiers of open lattice stepping inward, and a clock stage near the top whose hands actually turn.",
        "envelopeStuds": [
          32,
          null,
          32
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
        "pitch": 22,
        "zoom": 0.98
      },
      "documentId": "demo_iron_lattice_lookout",
      "roughDocumentId": "demo_iron_lattice_lookout_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/iron-lattice-lookout/document.json",
          "bytes": 2694388,
          "sha256": "ac2538de9b205c3ba95a97d7a303e49f41aec2634ea1d1a3e1dddaf23f8b92fa",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/iron-lattice-lookout/rough.json",
          "bytes": 659827,
          "sha256": "b5efc43c334db3e56ec0a79244a351ce5a9882f1d19d22a3d13351c2d7eb3314",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/iron-lattice-lookout/preview.json",
          "bytes": 61347,
          "sha256": "992fc1e2e582d7aae31b38a61457b21ac5b9079b0ab0adc8d3c487963563aa51",
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
          "bytes": 15346,
          "sha256": "ad4ca5a4c7a8dd9f75b80138cfcab316a854b6769482ffdcd888e9a13f7b184e",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/iron-lattice-lookout/social.png",
          "bytes": 27303,
          "sha256": "045de0bacd410d254407ec36c2f65b1b7cf0124d6a64cee3d2118efe57395d45",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 1118,
        "connectionCount": 6588,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 81,
        "weakAttachmentCount": 20,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -900,
            0
          ],
          "max": [
            640,
            0,
            640
          ],
          "size": [
            640,
            900,
            640
          ]
        },
        "footprintStuds": [
          32,
          32
        ],
        "heightPlates": 112.5,
        "steps": 19,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 1879.98,
          "massLabel": "1.88 kg",
          "measuredParts": 1118,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "32.0 × 32.0 studs",
          "tippingMarginLdu": 319.51,
          "restingParts": 101,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 40,
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
        "partsAdded": 793,
        "connectionsAdded": 5019,
        "componentsBefore": 2,
        "componentsAfter": 1,
        "loosePartsBefore": 94,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 231,
        "unsupportedAfter": 40,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 454.16,
        "massAfterGrams": 1879.98,
        "stepsBefore": 7,
        "stepsAfter": 19
      },
      "bill": [
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 596
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 145
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 93
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 67
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 59
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 24
        },
        {
          "definitionId": "3023b",
          "name": "Plate 1 x 2",
          "count": 20
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 18
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 16
        },
        {
          "definitionId": "3666",
          "name": "Plate 1 x 6",
          "count": 16
        },
        {
          "definitionId": "3022",
          "name": "Plate 2 x 2",
          "count": 14
        },
        {
          "definitionId": "2465",
          "name": "Brick 1 x 16",
          "count": 12
        }
      ],
      "distinctParts": 19,
      "planWarnings": [
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
      "id": "harbour-control-tower",
      "title": "Harbour Control Tower",
      "discipline": "Play set",
      "category": "architecture",
      "tagline": "A quayside podium with drive-in vehicle bays, a metro platform, a glazed control shaft and a crane that luffs.",
      "summary": "An original quayside play set rather than another facade: two full-height vehicle bays cut through the podium, a metro platform along the seaward edge, a glazed control shaft with a control room on top, and a quay crane built by the kernel’s own planner on a real luffing hinge.",
      "techniques": [
        "Full-height drive-in vehicle bays",
        "Raised metro platform",
        "Glazed control shaft",
        "Crane on a real luffing hinge",
        "One subassembly per programme element"
      ],
      "showcase": null,
      "refinement": "The rough candidate was a single glazed block on a plain slab — a tower with nothing to do. The published set cuts the podium open for vehicles, raises a platform along the quay, and puts a crane on the roof that the joint solver can actually drive.",
      "hero": false,
      "tensionAllowance": 420,
      "tensionReason": "Glazing is seated inside its frames and the podium roof deck rests on the walls below it at the perimeter rather than clutching down into them. The statics pass counts both as tension-carried; the allowance is bounded so a genuinely unsupported deck still fails the gate.",
      "brief": {
        "prompt": "A quayside control tower with two drive-in vehicle bays under the podium, a metro platform along the water, a glazed control shaft with a control room on top, and a working crane on the podium roof.",
        "envelopeStuds": [
          44,
          null,
          30
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
        "zoom": 1.02
      },
      "documentId": "demo_harbour_control_tower",
      "roughDocumentId": "demo_harbour_control_tower_rough",
      "schemaVersion": 2,
      "catalogVersion": "2026-07",
      "authoredAt": "2026-07-01T00:00:00.000Z",
      "assets": {
        "document": {
          "url": "/demos/harbour-control-tower/document.json",
          "bytes": 4339578,
          "sha256": "6c2af4f8a22daa22f53961e7f62f70565b4843e217bd55dbb31f6fce7234b82c",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/harbour-control-tower/rough.json",
          "bytes": 1045080,
          "sha256": "85eb62b10d076bce8412a1fbacdf0bb470ed3cabc7b510b93a4b6ec0df4047b3",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/harbour-control-tower/preview.json",
          "bytes": 61634,
          "sha256": "8dbcf4173c54d4ca0ad118cc45816853187d45b460495398dcc1e8a7d43a9151",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/harbour-control-tower/rough-preview.json",
          "bytes": 20869,
          "sha256": "b5263a11f961e12358aac2bdda57ffbbf2ddd9a66117588b0db7a7f0c4fb0a13",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/harbour-control-tower/thumb.png",
          "bytes": 22138,
          "sha256": "c35c013b88b18db4f412e6a064b815e3985eee2a6217364539d3f9a65b3d71e1",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/harbour-control-tower/social.png",
          "bytes": 38864,
          "sha256": "42c0cabbd431d3e897b35beac8fa97d4d877923ce540f2667ee58ba2c025dff2",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 1080,
        "connectionCount": 10991,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 124,
        "weakAttachmentCount": 23,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -804,
            0
          ],
          "max": [
            1200,
            0,
            800
          ],
          "size": [
            1200,
            804,
            800
          ]
        },
        "footprintStuds": [
          60,
          40
        ],
        "heightPlates": 100.5,
        "steps": 19,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 3279.68,
          "massLabel": "3.28 kg",
          "measuredParts": 1080,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "60.0 × 40.0 studs",
          "tippingMarginLdu": 351.8,
          "restingParts": 207,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 26,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 302,
        "connectionCount": 2615,
        "collisionCount": 5,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 25,
        "weakAttachmentCount": 17,
        "healthy": false,
        "boundsLdu": {
          "min": [
            0,
            -364,
            0
          ],
          "max": [
            560,
            0,
            400
          ],
          "size": [
            560,
            364,
            400
          ]
        },
        "footprintStuds": [
          28,
          20
        ],
        "heightPlates": 45.5,
        "steps": 8,
        "buildOrderVerified": true,
        "buildOrderWarnings": [
          "Step 7 adds part_0226 into a pose already enclosed by part_0154, part_0162 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 7 adds part_0227 into a pose already enclosed by part_0154, part_0163 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 759.81,
          "massLabel": "760 g",
          "measuredParts": 302,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "28.0 × 20.0 studs",
          "tippingMarginLdu": 196.96,
          "restingParts": 63,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 7,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 778,
        "connectionsAdded": 8376,
        "componentsBefore": 1,
        "componentsAfter": 1,
        "loosePartsBefore": 0,
        "loosePartsAfter": 0,
        "collisionsBefore": 5,
        "collisionsAfter": 0,
        "unsupportedBefore": 7,
        "unsupportedAfter": 26,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 759.81,
        "massAfterGrams": 3279.68,
        "stepsBefore": 8,
        "stepsAfter": 19
      },
      "bill": [
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 221
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 99
        },
        {
          "definitionId": "3005",
          "name": "Brick 1 x 1",
          "count": 96
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 94
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 87
        },
        {
          "definitionId": "3020",
          "name": "Plate 2 x 4",
          "count": 66
        },
        {
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 50
        },
        {
          "definitionId": "3795",
          "name": "Plate 2 x 6",
          "count": 47
        },
        {
          "definitionId": "2465",
          "name": "Brick 1 x 16",
          "count": 40
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 36
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 36
        },
        {
          "definitionId": "60479",
          "name": "Plate 1 x 12",
          "count": 32
        }
      ],
      "distinctParts": 29,
      "planWarnings": [
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
      "tagline": "A lozenge hull with sideways-stud skins, twin forward booms, a turret that turns and a ramp that opens.",
      "summary": "An original freighter: a cross-bonded keel, a sideways-stud hull skin built by the kernel’s own SNOT planner, twin booms flanking a centred cockpit, and two real hinges — a dorsal turret and a boarding ramp — that the joint solver drives in the editor.",
      "techniques": [
        "Sideways-stud hull skin (SNOT)",
        "Stepped lozenge planform",
        "Twin booms, centred cockpit",
        "Hinged boarding ramp",
        "Hinged dorsal turret"
      ],
      "showcase": null,
      "refinement": "The rough candidate was a single rectangular slab with the cockpit sitting on top of it — a box with a windscreen. The published set steps the hull in at bow and stern, wraps it in a genuinely clutched sideways skin, and replaces the moulded-on details with two hinges the kernel can actually drive.",
      "hero": false,
      "tensionAllowance": 320,
      "tensionReason": "The sideways skins hang from side-facing studs on the rim brackets and the hinged flaps rest on their knuckles rather than clutching down into the deck. The statics pass counts both as tension-carried; the allowance is bounded so an actually unsupported panel still fails the gate.",
      "brief": {
        "prompt": "An original saucer freighter with a stepped lozenge hull, sideways-stud skins, twin forward booms either side of a centred cockpit, a dorsal turret that turns and a boarding ramp that opens.",
        "envelopeStuds": [
          42,
          null,
          22
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
          "bytes": 3888833,
          "sha256": "b9c020f74bbe5b0455c1130c5790011780a520b07db18a00204e51e8133afd05",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/saucer-freighter/rough.json",
          "bytes": 614334,
          "sha256": "dcd1b968ae3d27cf899d08b818de1f99591858168f88d0a1d174133eb56edb7d",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/saucer-freighter/preview.json",
          "bytes": 117298,
          "sha256": "832dadcae451b9eca8e99848e7aac141c1f4f9733ba88e13123f4197bc0624d9",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/saucer-freighter/rough-preview.json",
          "bytes": 17056,
          "sha256": "6c3fcd37338722d4f5fbdbd8bd5d7b7729042e6ec94f67b7103fd5655b5a7f5c",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/saucer-freighter/thumb.png",
          "bytes": 27700,
          "sha256": "207d703c1300eb999967205623f2f637270b9d9610c4f107826f30793a264644",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/saucer-freighter/social.png",
          "bytes": 48139,
          "sha256": "7100e48c04e9d371db40c332ac89fef294b14fe3e5607e292d192ff82459eafd",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 2268,
        "connectionCount": 9123,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 4,
        "weakAttachmentCount": 125,
        "healthy": true,
        "boundsLdu": {
          "min": [
            0,
            -196,
            0
          ],
          "max": [
            880,
            0,
            640
          ],
          "size": [
            880,
            196,
            640
          ]
        },
        "footprintStuds": [
          44,
          32
        ],
        "heightPlates": 24.5,
        "steps": 42,
        "buildOrderVerified": true,
        "buildOrderWarnings": [],
        "statics": {
          "massGrams": 2163.36,
          "massLabel": "2.16 kg",
          "measuredParts": 2268,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "44.0 × 32.0 studs",
          "tippingMarginLdu": 319.45,
          "restingParts": 134,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 221,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "roughValidation": {
        "revision": 1,
        "partCount": 253,
        "connectionCount": 1479,
        "collisionCount": 130,
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
          "Step 6 adds part_0226 into a pose already enclosed by part_0073, part_0155 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 6 adds part_0227 into a pose already enclosed by part_0073, part_0155 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0210 into a pose already enclosed by part_0196, part_0037 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0209 into a pose already enclosed by part_0184, part_0073 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0212 into a pose already enclosed by part_0198, part_0073 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0211 into a pose already enclosed by part_0187, part_0073 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0213 into a pose already enclosed by part_0199, part_0075 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0214 into a pose already enclosed by part_0190, part_0201 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0217 into a pose already enclosed by part_0207, part_0206 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0220 into a pose already enclosed by part_0201, part_0190. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0223 into a pose already enclosed by part_0171, part_0201 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0221 into a pose already enclosed by part_0191, part_0202. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 8 adds part_0215 into a pose already enclosed by part_0191, part_0201 +1. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0230 into a pose already enclosed by part_0196, part_0151 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0229 into a pose already enclosed by part_0184, part_0153 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0232 into a pose already enclosed by part_0198, part_0151 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0231 into a pose already enclosed by part_0187, part_0155 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0233 into a pose already enclosed by part_0199, part_0149 +4. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0234 into a pose already enclosed by part_0190, part_0155 +3. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0237 into a pose already enclosed by part_0205, part_0149 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report.",
          "Step 9 adds part_0243 into a pose already enclosed by part_0201, part_0151 +2. Connected, but not reachable — place it before what encloses it. Boxes along six axes; may over-report."
        ],
        "statics": {
          "massGrams": 390.76,
          "massLabel": "391 g",
          "measuredParts": 253,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "18.0 × 14.0 studs",
          "tippingMarginLdu": 138.8,
          "restingParts": 28,
          "stable": true,
          "overloadedGroups": 0,
          "unsupportedParts": 48,
          "massBasis": "Computed from each part’s exact compiled LDraw volume at 1.05 g/cm³. LDraw models idealized solids, so absolute mass runs roughly 8–15% heavy against a moulded element; the bias is uniform, so centre of mass, load share and tipping margin are unaffected.",
          "clutchGramsPerStud": 100
        }
      },
      "delta": {
        "partsAdded": 2015,
        "connectionsAdded": 7644,
        "componentsBefore": 1,
        "componentsAfter": 1,
        "loosePartsBefore": 0,
        "loosePartsAfter": 0,
        "collisionsBefore": 130,
        "collisionsAfter": 0,
        "unsupportedBefore": 48,
        "unsupportedAfter": 221,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 390.76,
        "massAfterGrams": 2163.36,
        "stepsBefore": 11,
        "stepsAfter": 42
      },
      "bill": [
        {
          "definitionId": "3024",
          "name": "Plate 1 x 1",
          "count": 1624
        },
        {
          "definitionId": "4282",
          "name": "Plate 2 x 16",
          "count": 151
        },
        {
          "definitionId": "87087",
          "name": "Brick Special 1 x 1 with Stud on 1 Side",
          "count": 108
        },
        {
          "definitionId": "3034",
          "name": "Plate 2 x 8",
          "count": 75
        },
        {
          "definitionId": "3020",
          "name": "Plate 2 x 4",
          "count": 47
        },
        {
          "definitionId": "3832",
          "name": "Plate 2 x 10",
          "count": 45
        },
        {
          "definitionId": "3022",
          "name": "Plate 2 x 2",
          "count": 44
        },
        {
          "definitionId": "3008",
          "name": "Brick 1 x 8",
          "count": 38
        },
        {
          "definitionId": "3009",
          "name": "Brick 1 x 6",
          "count": 28
        },
        {
          "definitionId": "3666",
          "name": "Plate 1 x 6",
          "count": 20
        },
        {
          "definitionId": "2465",
          "name": "Brick 1 x 16",
          "count": 18
        },
        {
          "definitionId": "3010",
          "name": "Brick 1 x 4",
          "count": 16
        }
      ],
      "distinctParts": 19,
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
          "bytes": 4860618,
          "sha256": "3f1530df2a60caa15eae39af592f8dc64278668b4d0b3d5e81bd29f53eb44b58",
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
          "bytes": 166851,
          "sha256": "32a5ac26e034b9644fe5b96013b447b2951b56d29661c1cd3728b0ec030c85ad",
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
          "bytes": 28387,
          "sha256": "61062bdf71eb2c6ded4423cc41d674ebc7020f612200d92100553494f867044b",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/harbour-street/social.png",
          "bytes": 46286,
          "sha256": "e982509e6281b152fbf82fc8d28f61c6a57fa22e72256d4bf61648ade205dd54",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 3061,
        "connectionCount": 10882,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 8,
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
          "massGrams": 3628.34,
          "massLabel": "3.63 kg",
          "measuredParts": 3061,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "76.0 × 34.0 studs",
          "tippingMarginLdu": 276.18,
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
        "partsAdded": 1966,
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
        "massBeforeGrams": 979.63,
        "massAfterGrams": 3628.34,
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
          "count": 230
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
      "distinctParts": 22,
      "planWarnings": [
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "No door frame 4 studs wide is compiled in this build, so that opening is a bare hole.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there.",
        "Course 1 shares 1 seam(s) with the course below over a 14-stud run; the available lengths do not permit a full stagger there."
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
          "bytes": 11882518,
          "sha256": "8502295f852a0768e98ccf59da2c01afed9004ba604ff40ec0e0904da25540c5",
          "contentType": "application/json"
        },
        "rough": {
          "url": "/demos/meridian-tower/rough.json",
          "bytes": 3271257,
          "sha256": "89da0338213756a0ada3b64f268bc53a2730502a274a7e99b68391257baa0e28",
          "contentType": "application/json"
        },
        "preview": {
          "url": "/demos/meridian-tower/preview.json",
          "bytes": 264924,
          "sha256": "9ca7b4c16e260e22d98e657e8f6f0362dee6ae93bc5d4e0ef101cebad482a22b",
          "contentType": "application/json"
        },
        "roughPreview": {
          "url": "/demos/meridian-tower/rough-preview.json",
          "bytes": 115523,
          "sha256": "85f5bb11234678d5b761b48565457e2e7e4fd28a563ab2643a9da531ac1d8d75",
          "contentType": "application/json"
        },
        "thumbnail": {
          "url": "/demos/meridian-tower/thumb.png",
          "bytes": 14401,
          "sha256": "fc0f2441df1deefab53d25e68c6e0c856f2ecdb951459679a4347b5295d55b3c",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/meridian-tower/social.png",
          "bytes": 22865,
          "sha256": "ff599ab07dc4b7c6c75b80e2756553392080aaae72c244643c9009acc664a91f",
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
          "massGrams": 9818.68,
          "massLabel": "9.82 kg",
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
          "massGrams": 2668.93,
          "massLabel": "2.67 kg",
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
        "massBeforeGrams": 2668.93,
        "massAfterGrams": 9818.68,
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
          "definitionId": "2465",
          "name": "Brick 1 x 16",
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
      "category": "architecture",
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
          "bytes": 12544456,
          "sha256": "ab2d39d4bf6134b785a20e0c7884500b889aba4a04c838539ed6dd574bc7434d",
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
          "bytes": 615099,
          "sha256": "9d80306675dd18eb26d426ee46c71be9477a61866a8868bd00aa5ca7a335b3c7",
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
          "bytes": 48249,
          "sha256": "ee59a426fc9933316938884a2baa35e2e8785e78bd5dcdccdc220f25f699ff47",
          "contentType": "image/png"
        },
        "social": {
          "url": "/demos/illinois-main-quad/social.png",
          "bytes": 91291,
          "sha256": "d919e3ed540cf897d390a1e5e98c7e28827a0d04c4b4b89f59c256fc073a0fe7",
          "contentType": "image/png"
        }
      },
      "validation": {
        "revision": 1,
        "partCount": 11493,
        "connectionCount": 26496,
        "collisionCount": 0,
        "unverifiedCollisions": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "virtualColorCount": 55,
        "weakAttachmentCount": 9077,
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
          "massGrams": 7902.38,
          "massLabel": "7.90 kg",
          "measuredParts": 11493,
          "unmeasuredParts": 0,
          "coverage": 1,
          "supportLabel": "120.0 × 80.0 studs",
          "tippingMarginLdu": 783.6,
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
        "partsAdded": 11067,
        "connectionsAdded": 25580,
        "componentsBefore": 206,
        "componentsAfter": 1,
        "loosePartsBefore": 352,
        "loosePartsAfter": 0,
        "collisionsBefore": 0,
        "collisionsAfter": 0,
        "unsupportedBefore": 0,
        "unsupportedAfter": 56,
        "stableBefore": true,
        "stableAfter": true,
        "massBeforeGrams": 2075.86,
        "massAfterGrams": 7902.38,
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
          "definitionId": "3004",
          "name": "Brick 1 x 2",
          "count": 68
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
