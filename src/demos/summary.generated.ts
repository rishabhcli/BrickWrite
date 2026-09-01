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
      "tagline": "An eighty-four-stud blue whale with fins, flukes and foam rising from an illuminated ocean promenade.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 12794,
        "connectionCount": 16059,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          84,
          42
        ],
        "steps": 135,
        "statics": {
          "massLabel": "6.28 kg",
          "stable": true,
          "tippingMarginLdu": 413.19,
          "unsupportedParts": 0
        }
      },
      "roughValidation": {
        "partCount": 1976,
        "connectionCount": 1937,
        "collisionCount": 0,
        "componentCount": 39,
        "disconnectedPartCount": 1824,
        "footprintStuds": [
          42,
          22
        ],
        "steps": 173,
        "statics": {
          "massLabel": "840 g",
          "stable": true,
          "tippingMarginLdu": 214.2,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 10818,
        "connectionsAdded": 14122
      }
    },
    {
      "id": "sunline-suspension-bridge",
      "title": "Sunline Suspension Bridge",
      "discipline": "Landmark infrastructure",
      "category": "landmarks",
      "tagline": "Twin brick-red gateways carry a raised road and stepped golden hangers across a 120-stud river district.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 8021,
        "connectionCount": 16433,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          120,
          50
        ],
        "steps": 87,
        "statics": {
          "massLabel": "4.97 kg",
          "stable": true,
          "tippingMarginLdu": 499.97,
          "unsupportedParts": 19
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
        "partsAdded": 6745,
        "connectionsAdded": 15201
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 9421,
        "connectionCount": 12184,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          68,
          44
        ],
        "steps": 101,
        "statics": {
          "massLabel": "4.65 kg",
          "stable": true,
          "tippingMarginLdu": 434.11,
          "unsupportedParts": 0
        }
      },
      "roughValidation": {
        "partCount": 1439,
        "connectionCount": 1406,
        "collisionCount": 0,
        "componentCount": 33,
        "disconnectedPartCount": 1288,
        "footprintStuds": [
          34,
          22
        ],
        "steps": 124,
        "statics": {
          "massLabel": "602 g",
          "stable": true,
          "tippingMarginLdu": 214.74,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 7982,
        "connectionsAdded": 10778
      }
    },
    {
      "id": "colossal-duck",
      "title": "Colossal Duck Float",
      "discipline": "Playful public art",
      "category": "creative",
      "tagline": "A giant yellow duck, orange bill and all, bobbing over a sixty-four-stud illuminated festival basin.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 10515,
        "connectionCount": 13221,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          64,
          46
        ],
        "steps": 112,
        "statics": {
          "massLabel": "5.16 kg",
          "stable": true,
          "tippingMarginLdu": 454.52,
          "unsupportedParts": 0
        }
      },
      "roughValidation": {
        "partCount": 1485,
        "connectionCount": 1449,
        "collisionCount": 0,
        "componentCount": 36,
        "disconnectedPartCount": 1338,
        "footprintStuds": [
          32,
          24
        ],
        "steps": 139,
        "statics": {
          "massLabel": "621 g",
          "stable": true,
          "tippingMarginLdu": 235.54,
          "unsupportedParts": 0
        }
      },
      "delta": {
        "partsAdded": 9030,
        "connectionsAdded": 11772
      }
    },
    {
      "id": "iron-lattice-lookout",
      "title": "Iron Lattice Lookout",
      "discipline": "Landmark ironwork",
      "category": "landmarks",
      "tagline": "Two tall tiers of open lattice rise from a landscaped civic garden to a clock stage and glazed lookout.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 4734,
        "connectionCount": 15522,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          56,
          56
        ],
        "steps": 77,
        "statics": {
          "massLabel": "4.56 kg",
          "stable": true,
          "tippingMarginLdu": 559.77,
          "unsupportedParts": 62
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
        "partsAdded": 4409,
        "connectionsAdded": 13953
      }
    },
    {
      "id": "harbour-control-tower",
      "title": "Harbour Control Tower",
      "discipline": "Play set",
      "category": "architecture",
      "tagline": "An eighty-four-stud harbour district with drive-in bays, a metro platform, a glazed control shaft and a crane that luffs.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 3564,
        "connectionCount": 22654,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          84,
          56
        ],
        "steps": 52,
        "statics": {
          "massLabel": "6.59 kg",
          "stable": true,
          "tippingMarginLdu": 476.65,
          "unsupportedParts": 73
        }
      },
      "roughValidation": {
        "partCount": 312,
        "connectionCount": 2674,
        "collisionCount": 5,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          28,
          20
        ],
        "steps": 8,
        "statics": {
          "massLabel": "774 g",
          "stable": true,
          "tippingMarginLdu": 197.72,
          "unsupportedParts": 7
        }
      },
      "delta": {
        "partsAdded": 3252,
        "connectionsAdded": 19980
      }
    },
    {
      "id": "saucer-freighter",
      "title": "Saucer Freighter",
      "discipline": "Vehicle and mechanism",
      "category": "vehicles",
      "tagline": "A faceted lozenge hull on a seventy-stud illuminated dock, with twin booms, a turning turret and opening ramp.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 5350,
        "connectionCount": 16000,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          70,
          56
        ],
        "steps": 90,
        "statics": {
          "massLabel": "4.02 kg",
          "stable": true,
          "tippingMarginLdu": 559.72,
          "unsupportedParts": 462
        }
      },
      "roughValidation": {
        "partCount": 229,
        "connectionCount": 1299,
        "collisionCount": 34,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          18,
          14
        ],
        "steps": 11,
        "statics": {
          "massLabel": "313 g",
          "stable": true,
          "tippingMarginLdu": 138.47,
          "unsupportedParts": 48
        }
      },
      "delta": {
        "partsAdded": 5121,
        "connectionsAdded": 14701
      }
    },
    {
      "id": "harbour-street",
      "title": "Harbour Street",
      "discipline": "Modular architecture",
      "category": "architecture",
      "tagline": "Seven four-storey shopfronts, separated by alleys and finished with roof rooms, trees, lights and planted entries.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 7913,
        "connectionCount": 29204,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          134,
          50
        ],
        "steps": 114,
        "statics": {
          "massLabel": "9.56 kg",
          "stable": true,
          "tippingMarginLdu": 385.89,
          "unsupportedParts": 154
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
        "partsAdded": 6818,
        "connectionsAdded": 26708
      }
    },
    {
      "id": "meridian-tower",
      "title": "Meridian Tower",
      "discipline": "Modular architecture",
      "category": "architecture",
      "tagline": "A twenty-eight-storey modular high-rise with two setbacks, a complete civic plaza and real seated glazing.",
      "hero": false,
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 8895,
        "connectionCount": 47385,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          84,
          52
        ],
        "steps": 136,
        "statics": {
          "massLabel": "16.18 kg",
          "stable": true,
          "tippingMarginLdu": 519.98,
          "unsupportedParts": 855
        }
      },
      "roughValidation": {
        "partCount": 2134,
        "connectionCount": 7382,
        "collisionCount": 0,
        "componentCount": 53,
        "disconnectedPartCount": 1060,
        "footprintStuds": [
          58,
          30
        ],
        "steps": 69,
        "statics": {
          "massLabel": "2.71 kg",
          "stable": true,
          "tippingMarginLdu": 299.97,
          "unsupportedParts": 90
        }
      },
      "delta": {
        "partsAdded": 6761,
        "connectionsAdded": 40003
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
      "catalogVersion": "2026-07",
      "assets": {
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
        }
      },
      "validation": {
        "partCount": 13844,
        "connectionCount": 32172,
        "collisionCount": 0,
        "componentCount": 1,
        "disconnectedPartCount": 0,
        "footprintStuds": [
          128,
          88
        ],
        "steps": 221,
        "statics": {
          "massLabel": "9.75 kg",
          "stable": true,
          "tippingMarginLdu": 843.9,
          "unsupportedParts": 68
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
        "partsAdded": 13418,
        "connectionsAdded": 31256
      }
    }
  ]
}

export default DEMO_SUMMARY_MANIFEST
