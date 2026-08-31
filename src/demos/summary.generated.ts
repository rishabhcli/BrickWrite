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
      "tagline": "A sixty-four-stud blue whale with fins, flukes and foam rising from an editable ocean mosaic.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
          "bytes": 33253,
          "sha256": "eac193c65c01ae75d678789a1d8b01b69b3248fec6927837ab4bbf3735a963d8",
          "contentType": "image/png"
        }
      },
      "validation": {
        "partCount": 6534,
        "connectionCount": 8296,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          64,
          30
        ],
        "steps": 69,
        "statics": {
          "massLabel": "3.22 kg",
          "stable": true,
          "tippingMarginLdu": 293.33,
          "unsupportedParts": 0
        }
      },
      "roughValidation": {
        "partCount": 2179,
        "connectionCount": 2140,
        "collisionCount": 0,
        "componentCount": 39,
        "disconnectedPartCount": 2031,
        "footprintStuds": [
          42,
          22
        ],
        "steps": 184,
        "statics": {
          "massLabel": "938 g",
          "stable": true,
          "tippingMarginLdu": 213.76,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 4355,
        "connectionsAdded": 6156
      }
    },
    {
      "id": "sunline-suspension-bridge",
      "title": "Sunline Suspension Bridge",
      "discipline": "Landmark infrastructure",
      "category": "landmarks",
      "tagline": "Twin brick-red gateways carry a road and stepped golden hangers across a ninety-two-stud river.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
          "bytes": 38370,
          "sha256": "12d7f529d1abcf5818d81d135991faf7402b7920614e0492f03138ccef4e4a22",
          "contentType": "image/png"
        }
      },
      "validation": {
        "partCount": 4295,
        "connectionCount": 9170,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          92,
          34
        ],
        "steps": 46,
        "statics": {
          "massLabel": "2.56 kg",
          "stable": true,
          "tippingMarginLdu": 339.94,
          "unsupportedParts": 8
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
        "partsAdded": 3019,
        "connectionsAdded": 7938
      }
    },
    {
      "id": "copper-mammoth",
      "title": "Copper Canyon Mammoth",
      "discipline": "Large animal sculpture",
      "category": "animals",
      "tagline": "A brick-built mammoth with a domed back, four legs, a long trunk, amber ears and paired ivory tusks.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
          "bytes": 32444,
          "sha256": "da5cb894cb6bceab6a709b2cd2afa075e50baae25c939e5b0e3cb1da67311442",
          "contentType": "image/png"
        }
      },
      "validation": {
        "partCount": 4458,
        "connectionCount": 5924,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          50,
          32
        ],
        "steps": 48,
        "statics": {
          "massLabel": "2.20 kg",
          "stable": true,
          "tippingMarginLdu": 314.05,
          "unsupportedParts": 0
        }
      },
      "roughValidation": {
        "partCount": 1508,
        "connectionCount": 1475,
        "collisionCount": 0,
        "componentCount": 33,
        "disconnectedPartCount": 1356,
        "footprintStuds": [
          34,
          22
        ],
        "steps": 128,
        "statics": {
          "massLabel": "635 g",
          "stable": true,
          "tippingMarginLdu": 214.49,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 2950,
        "connectionsAdded": 4449
      }
    },
    {
      "id": "colossal-duck",
      "title": "Colossal Duck Float",
      "discipline": "Playful public art",
      "category": "creative",
      "tagline": "A giant yellow duck, orange bill and all, bobbing over a forty-six-stud festival-water mosaic.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
          "bytes": 35216,
          "sha256": "c62074bf7dd26fad2fa43f906f5aaf4f2343f45a308b0e3163a3b17f49a08c29",
          "contentType": "image/png"
        }
      },
      "validation": {
        "partCount": 4975,
        "connectionCount": 6397,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          46,
          34
        ],
        "steps": 55,
        "statics": {
          "massLabel": "2.45 kg",
          "stable": true,
          "tippingMarginLdu": 333.57,
          "unsupportedParts": 0
        }
      },
      "roughValidation": {
        "partCount": 1598,
        "connectionCount": 1562,
        "collisionCount": 0,
        "componentCount": 36,
        "disconnectedPartCount": 1447,
        "footprintStuds": [
          32,
          24
        ],
        "steps": 141,
        "statics": {
          "massLabel": "675 g",
          "stable": true,
          "tippingMarginLdu": 235.05,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 3377,
        "connectionsAdded": 4835
      }
    },
    {
      "id": "iron-lattice-lookout",
      "title": "Iron Lattice Lookout",
      "discipline": "Landmark ironwork",
      "category": "landmarks",
      "tagline": "Two tiers of open lattice over an arched masonry plinth, topped by a clock stage with four hinged hands.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
          "bytes": 15349,
          "sha256": "44769fffa1739d3c00d4bdcd61a7ad11258cddeaf5f3a348f222d1332b767d30",
          "contentType": "image/png"
        }
      },
      "validation": {
        "partCount": 1118,
        "connectionCount": 6588,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          32,
          32
        ],
        "steps": 19,
        "statics": {
          "massLabel": "1.88 kg",
          "stable": true,
          "tippingMarginLdu": 319.51,
          "unsupportedParts": 40
        }
      },
      "roughValidation": {
        "partCount": 325,
        "connectionCount": 1569,
        "collisionCount": 0,
        "componentCount": 2,
        "disconnectedPartCount": 94,
        "footprintStuds": [
          16,
          16
        ],
        "steps": 7,
        "statics": {
          "massLabel": "454 g",
          "stable": true,
          "tippingMarginLdu": 156.35,
          "unsupportedParts": 231
        }
      },
      "delta": {
        "partsAdded": 793,
        "connectionsAdded": 5019
      }
    },
    {
      "id": "harbour-control-tower",
      "title": "Harbour Control Tower",
      "discipline": "Play set",
      "category": "architecture",
      "tagline": "A quayside podium with drive-in vehicle bays, a metro platform, a glazed control shaft and a crane that luffs.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
          "bytes": 22142,
          "sha256": "3944719ecd9ceaa85fb6861309d73e12230a337840a9f734c301886b2f7418dc",
          "contentType": "image/png"
        }
      },
      "validation": {
        "partCount": 1080,
        "connectionCount": 10991,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          60,
          40
        ],
        "steps": 19,
        "statics": {
          "massLabel": "3.28 kg",
          "stable": true,
          "tippingMarginLdu": 351.8,
          "unsupportedParts": 26
        }
      },
      "roughValidation": {
        "partCount": 302,
        "connectionCount": 2615,
        "collisionCount": 5,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          28,
          20
        ],
        "steps": 8,
        "statics": {
          "massLabel": "760 g",
          "stable": true,
          "tippingMarginLdu": 196.96,
          "unsupportedParts": 7
        }
      },
      "delta": {
        "partsAdded": 778,
        "connectionsAdded": 8376
      }
    },
    {
      "id": "saucer-freighter",
      "title": "Saucer Freighter",
      "discipline": "Vehicle and mechanism",
      "category": "vehicles",
      "tagline": "A lozenge hull with sideways-stud skins, twin forward booms, a turret that turns and a ramp that opens.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
          "bytes": 27706,
          "sha256": "cdcda62bc699027765c96d010b9d7ea263e564483a8d6bb760a9d3f7ad4685e4",
          "contentType": "image/png"
        }
      },
      "validation": {
        "partCount": 2268,
        "connectionCount": 9123,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          44,
          32
        ],
        "steps": 42,
        "statics": {
          "massLabel": "2.16 kg",
          "stable": true,
          "tippingMarginLdu": 319.45,
          "unsupportedParts": 221
        }
      },
      "roughValidation": {
        "partCount": 253,
        "connectionCount": 1479,
        "collisionCount": 130,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          18,
          14
        ],
        "steps": 11,
        "statics": {
          "massLabel": "391 g",
          "stable": true,
          "tippingMarginLdu": 138.8,
          "unsupportedParts": 48
        }
      },
      "delta": {
        "partsAdded": 2015,
        "connectionsAdded": 7644
      }
    },
    {
      "id": "harbour-street",
      "title": "Harbour Street",
      "discipline": "Modular architecture",
      "category": "architecture",
      "tagline": "A terrace of five shopfronts on a tiled street, every building and every floor separable.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
          "bytes": 28361,
          "sha256": "d78466dd46add871ce6c5422c924f374d6318918e8e7bffbbae4d7fabab99bcd",
          "contentType": "image/png"
        }
      },
      "validation": {
        "partCount": 3061,
        "connectionCount": 10882,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          76,
          34
        ],
        "steps": 45,
        "statics": {
          "massLabel": "3.63 kg",
          "stable": true,
          "tippingMarginLdu": 276.18,
          "unsupportedParts": 70
        }
      },
      "roughValidation": {
        "partCount": 1095,
        "connectionCount": 2496,
        "collisionCount": 0,
        "componentCount": 34,
        "disconnectedPartCount": 673,
        "footprintStuds": [
          34,
          34
        ],
        "steps": 42,
        "statics": {
          "massLabel": "980 g",
          "stable": true,
          "tippingMarginLdu": 278.54,
          "unsupportedParts": 16
        }
      },
      "delta": {
        "partsAdded": 1966,
        "connectionsAdded": 8386
      }
    },
    {
      "id": "meridian-tower",
      "title": "Meridian Tower",
      "discipline": "Modular architecture",
      "category": "architecture",
      "tagline": "A twenty-two-storey modular high-rise that lifts apart floor by floor, with real seated glazing.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
          "bytes": 14395,
          "sha256": "5e8162cae7aca32d344ebc1cb92b260717af46868c44e4ae99a7720a4a39a9bb",
          "contentType": "image/png"
        }
      },
      "validation": {
        "partCount": 4767,
        "connectionCount": 28196,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          58,
          30
        ],
        "steps": 68,
        "statics": {
          "massLabel": "9.82 kg",
          "stable": true,
          "tippingMarginLdu": 299.98,
          "unsupportedParts": 411
        }
      },
      "roughValidation": {
        "partCount": 2118,
        "connectionCount": 7268,
        "collisionCount": 0,
        "componentCount": 53,
        "disconnectedPartCount": 1060,
        "footprintStuds": [
          58,
          30
        ],
        "steps": 69,
        "statics": {
          "massLabel": "2.67 kg",
          "stable": true,
          "tippingMarginLdu": 299.97,
          "unsupportedParts": 87
        }
      },
      "delta": {
        "partsAdded": 2649,
        "connectionsAdded": 20928
      }
    },
    {
      "id": "illinois-main-quad",
      "title": "Illinois Main Quad campus",
      "discipline": "Campus architecture",
      "category": "architecture",
      "tagline": "A 120 × 80-stud university campus with seven landmarks, a tiled quad, trees, Morrow Plots and 21 LEGO characters.",
      "hero": true,
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
      "catalogVersion": "2026-07",
      "assets": {
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
          "bytes": 48216,
          "sha256": "96b537f5dcf7610455afa6b875138a2ba8a0d9664680543b55fd585dbc1540ff",
          "contentType": "image/png"
        }
      },
      "validation": {
        "partCount": 11493,
        "connectionCount": 26496,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          120,
          80
        ],
        "steps": 185,
        "statics": {
          "massLabel": "7.90 kg",
          "stable": true,
          "tippingMarginLdu": 783.6,
          "unsupportedParts": 56
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
        "partsAdded": 11067,
        "connectionsAdded": 25580
      }
    }
  ]
}

export default DEMO_SUMMARY_MANIFEST
