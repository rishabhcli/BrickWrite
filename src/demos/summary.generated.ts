/**
 * GENERATED FILE — do not edit.
 *
 * Landing-safe projection of the validated demo manifest. Full BOMs,
 * provenance and extended validation stay in the lazy Explore chunk.
 *
 * Rebuild with:  node tools/build-demos.mjs
 */
import type { DemoSummaryManifest } from './types'

export const DEMO_SUMMARY_MANIFEST: DemoSummaryManifest = {
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
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 9563,
        "connectionCount": 28535,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          132,
          56
        ],
        "steps": 103,
        "statics": {
          "massLabel": "9.24 kg",
          "stable": true,
          "tippingMarginLdu": 559.24,
          "unsupportedParts": 0
        }
      },
      "roughValidation": {
        "partCount": 4781,
        "connectionCount": 13530,
        "collisionCount": 0,
        "componentCount": 70,
        "disconnectedPartCount": 1921,
        "footprintStuds": [
          84,
          42
        ],
        "steps": 247,
        "statics": {
          "massLabel": "5.09 kg",
          "stable": true,
          "tippingMarginLdu": 320.68,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 4782,
        "connectionsAdded": 15005
      }
    },
    {
      "id": "sunline-suspension-bridge",
      "title": "Sunline Suspension Bridge",
      "discipline": "Landmark infrastructure",
      "category": "landmarks",
      "tagline": "Twin portal towers carry a 160-stud road deck and two stepped golden catenaries across a 168-stud river district.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 14714,
        "connectionCount": 41778,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          168,
          64
        ],
        "steps": 158,
        "statics": {
          "massLabel": "13.62 kg",
          "stable": true,
          "tippingMarginLdu": 639.99,
          "unsupportedParts": 171
        }
      },
      "roughValidation": {
        "partCount": 1276,
        "connectionCount": 1232,
        "collisionCount": 0,
        "componentCount": 44,
        "disconnectedPartCount": 1243,
        "footprintStuds": [
          56,
          22
        ],
        "steps": 131,
        "statics": {
          "massLabel": "470 g",
          "stable": true,
          "tippingMarginLdu": 220,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 13438,
        "connectionsAdded": 40546
      }
    },
    {
      "id": "copper-mammoth",
      "title": "Copper Canyon Mammoth",
      "discipline": "Large animal sculpture",
      "category": "animals",
      "tagline": "A 112-stud woolly mammoth standing on four legs, trunk down to the canyon floor and white tusks sweeping forward.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 14006,
        "connectionCount": 40037,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          112,
          64
        ],
        "steps": 150,
        "statics": {
          "massLabel": "14.51 kg",
          "stable": true,
          "tippingMarginLdu": 638.89,
          "unsupportedParts": 0
        }
      },
      "roughValidation": {
        "partCount": 4287,
        "connectionCount": 9797,
        "collisionCount": 0,
        "componentCount": 88,
        "disconnectedPartCount": 3320,
        "footprintStuds": [
          68,
          44
        ],
        "steps": 286,
        "statics": {
          "massLabel": "3.81 kg",
          "stable": true,
          "tippingMarginLdu": 305.09,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 9719,
        "connectionsAdded": 30240
      }
    },
    {
      "id": "colossal-duck",
      "title": "Colossal Duck Float",
      "discipline": "Playful public art",
      "category": "creative",
      "tagline": "A ninety-six-stud rubber duck: domed body, tall neck, cantilevered orange bill and a wake of lit moorings.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 9271,
        "connectionCount": 35814,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          96,
          68
        ],
        "steps": 100,
        "statics": {
          "massLabel": "11.95 kg",
          "stable": true,
          "tippingMarginLdu": 679.97,
          "unsupportedParts": 0
        }
      },
      "roughValidation": {
        "partCount": 4818,
        "connectionCount": 21767,
        "collisionCount": 0,
        "componentCount": 57,
        "disconnectedPartCount": 1344,
        "footprintStuds": [
          64,
          46
        ],
        "steps": 208,
        "statics": {
          "massLabel": "7.94 kg",
          "stable": true,
          "tippingMarginLdu": 294.45,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 4453,
        "connectionsAdded": 14047
      }
    },
    {
      "id": "iron-lattice-lookout",
      "title": "Iron Lattice Lookout",
      "discipline": "Landmark ironwork",
      "category": "landmarks",
      "tagline": "Two tapering tiers of open ironwork rise fifty-eight courses from an arched plinth to a glazed lookout and a clock stage.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 8604,
        "connectionCount": 29402,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          76,
          76
        ],
        "steps": 138,
        "statics": {
          "massLabel": "10.38 kg",
          "stable": true,
          "tippingMarginLdu": 757.68,
          "unsupportedParts": 28
        }
      },
      "roughValidation": {
        "partCount": 7803,
        "connectionCount": 21016,
        "collisionCount": 0,
        "componentCount": 159,
        "disconnectedPartCount": 5686,
        "footprintStuds": [
          76,
          76
        ],
        "steps": 546,
        "statics": {
          "massLabel": "8.07 kg",
          "stable": true,
          "tippingMarginLdu": 757.48,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 801,
        "connectionsAdded": 8386
      }
    },
    {
      "id": "harbour-control-tower",
      "title": "Harbour Control Tower",
      "discipline": "Play set",
      "category": "architecture",
      "tagline": "A 108-stud quay: two drive-through bays, eight container stacks, bunded tanks, a helipad and a glazed control room that overhangs its shaft.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 11226,
        "connectionCount": 34940,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          108,
          76
        ],
        "steps": 161,
        "statics": {
          "massLabel": "11.81 kg",
          "stable": true,
          "tippingMarginLdu": 651.94,
          "unsupportedParts": 11
        }
      },
      "roughValidation": {
        "partCount": 6702,
        "connectionCount": 19575,
        "collisionCount": 0,
        "componentCount": 107,
        "disconnectedPartCount": 3326,
        "footprintStuds": [
          84,
          56
        ],
        "steps": 384,
        "statics": {
          "massLabel": "7.43 kg",
          "stable": true,
          "tippingMarginLdu": 538.45,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 4524,
        "connectionsAdded": 15365
      }
    },
    {
      "id": "saucer-freighter",
      "title": "Saucer Freighter",
      "discipline": "Vehicle and mechanism",
      "category": "vehicles",
      "tagline": "A ninety-six-stud freighter on six landing legs: deep tapering hull, stepped upper deck, raised bridge and three lit engine bells.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 10338,
        "connectionCount": 52990,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          96,
          64
        ],
        "steps": 165,
        "statics": {
          "massLabel": "18.36 kg",
          "stable": true,
          "tippingMarginLdu": 639.13,
          "unsupportedParts": 8
        }
      },
      "roughValidation": {
        "partCount": 5594,
        "connectionCount": 23852,
        "collisionCount": 0,
        "componentCount": 115,
        "disconnectedPartCount": 3242,
        "footprintStuds": [
          70,
          52
        ],
        "steps": 383,
        "statics": {
          "massLabel": "9.08 kg",
          "stable": true,
          "tippingMarginLdu": 425.75,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 4744,
        "connectionsAdded": 29138
      }
    },
    {
      "id": "harbour-street",
      "title": "Harbour Street",
      "discipline": "Modular architecture",
      "category": "architecture",
      "tagline": "Seven four-storey shopfronts under three different rooflines — pitched gables with chimneys, stepped parapets and flat roofs with roof rooms.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 7947,
        "connectionCount": 29697,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          134,
          50
        ],
        "steps": 114,
        "statics": {
          "massLabel": "9.91 kg",
          "stable": true,
          "tippingMarginLdu": 383.79,
          "unsupportedParts": 148
        }
      },
      "roughValidation": {
        "partCount": 1121,
        "connectionCount": 2678,
        "collisionCount": 0,
        "componentCount": 34,
        "disconnectedPartCount": 673,
        "footprintStuds": [
          34,
          34
        ],
        "steps": 42,
        "statics": {
          "massLabel": "1.08 kg",
          "stable": true,
          "tippingMarginLdu": 275.66,
          "unsupportedParts": 16
        }
      },
      "delta": {
        "partsAdded": 6826,
        "connectionsAdded": 27019
      }
    },
    {
      "id": "meridian-tower",
      "title": "Meridian Tower",
      "discipline": "Modular architecture",
      "category": "architecture",
      "tagline": "A twenty-eight-storey modular high-rise with two setbacks, a seven-course crown and a 108-stud civic plaza.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 12639,
        "connectionCount": 55021,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          108,
          72
        ],
        "steps": 188,
        "statics": {
          "massLabel": "18.26 kg",
          "stable": true,
          "tippingMarginLdu": 719.95,
          "unsupportedParts": 855
        }
      },
      "roughValidation": {
        "partCount": 2172,
        "connectionCount": 7724,
        "collisionCount": 0,
        "componentCount": 53,
        "disconnectedPartCount": 1060,
        "footprintStuds": [
          58,
          30
        ],
        "steps": 70,
        "statics": {
          "massLabel": "2.85 kg",
          "stable": true,
          "tippingMarginLdu": 299.97,
          "unsupportedParts": 90
        }
      },
      "delta": {
        "partsAdded": 10467,
        "connectionsAdded": 47297
      }
    },
    {
      "id": "illinois-main-quad",
      "title": "Illinois Main Quad campus",
      "discipline": "Campus architecture",
      "category": "architecture",
      "tagline": "A 128 × 88-stud university campus with nine landmark structures, a tiled quad, mature trees, path lights and 21 LEGO characters.",
      "hero": true,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 13835,
        "connectionCount": 31234,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          128,
          88
        ],
        "steps": 221,
        "statics": {
          "massLabel": "10.06 kg",
          "stable": true,
          "tippingMarginLdu": 837.66,
          "unsupportedParts": 70
        }
      },
      "roughValidation": {
        "partCount": 426,
        "connectionCount": 916,
        "collisionCount": 0,
        "componentCount": 206,
        "disconnectedPartCount": 352,
        "footprintStuds": [
          120,
          80
        ],
        "steps": 214,
        "statics": {
          "massLabel": "2.08 kg",
          "stable": true,
          "tippingMarginLdu": 785.75,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 13409,
        "connectionsAdded": 30318
      }
    }
  ]
}

export default DEMO_SUMMARY_MANIFEST
