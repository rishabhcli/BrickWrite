import { IDENTITY_BASIS, basisFromEulerDegrees, cleanBasis } from '../../../cad/math'
import type { ModelDocument, ValidationReport } from '../../../cad/types'
import type { ShareMesh } from '../render/scene'

/**
 * A document that contains everything a publication must not leak.
 *
 * The privacy test is only as strong as the fixture it runs against, so this
 * one deliberately carries a private note, an agent prompt and its response, a
 * constraint whose value is the original design brief, protected parts,
 * per-part transaction references, a signed asset URL and a private project id.
 * Every one of those strings is a distinctive marker the test greps for.
 */

export const SECRETS = {
  projectId: 'prj_PRIVATE_PROJECT_HANDLE_9f2a',
  note: 'PRIVATE-NOTE the client hates the orange, do not ship',
  noteResponse: 'AGENT-RESPONSE recoloured the bay per the brief',
  prompt: 'SECRET-PROMPT build a surveillance rover for a private client, budget 40k',
  transaction: 'txn_SECRET_TRANSACTION_0007',
  signedUrl: 'https://assets.example.invalid/private.bwmesh?X-Amz-Signature=SIGNEDURLSECRET',
  moduleName: 'PRIVATE-MODULE cockpit revision C',
  constraintLabel: 'PRIVATE-CONSTRAINT client budget ceiling',
  createdAt: '2024-01-02T03:04:05.000Z',
  updatedAt: '2024-06-07T08:09:10.000Z',
} as const

/** Twelve triangles around the origin: enough to shade, occlude and frame. */
export function boxMesh(size = 20, height = 24, depth = 20): ShareMesh {
  const x = size / 2
  const y = height / 2
  const z = depth / 2
  const corners = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ]
  const faces = [
    [0, 1, 2], [0, 2, 3],
    [5, 4, 7], [5, 7, 6],
    [4, 0, 3], [4, 3, 7],
    [1, 5, 6], [1, 6, 2],
    [4, 5, 1], [4, 1, 0],
    [3, 2, 6], [3, 6, 7],
  ]
  return {
    positions: new Float32Array(corners.flat()),
    indices: new Uint32Array(faces.flat()),
    slices: [{ colour: 16, start: 0, count: faces.length * 3 }],
  }
}

/** Every definition resolves to the same box, which is all a render needs. */
export const boxGeometry = () => boxMesh()

/** Nothing resolves, so the "no compiled geometry" paths can be exercised. */
export const noGeometry = () => null

/**
 * Six parts in two subassemblies and three steps, plus every private field.
 *
 * Small enough that a full render in a test is milliseconds, structured enough
 * that step scrubbing, exploded views and the connection graph all have
 * something real to work on.
 */
export function privateDocument(revision = 12): ModelDocument {
  const positions: Array<[number, number, number]> = [
    [0, 0, 0],
    [40, 0, 0],
    [0, -24, 0],
    [40, -24, 0],
    [20, -48, 0],
    [20, -48, 40],
  ]
  const parts: ModelDocument['parts'] = {}
  positions.forEach((position, index) => {
    const id = `part_${String(index + 1).padStart(3, '0')}`
    parts[id] = {
      id,
      definitionId: index % 2 === 0 ? '3001' : '3020',
      color: index % 2 === 0 ? 4 : 15,
      transform: {
        position,
        basis: index === 5 ? cleanBasis(basisFromEulerDegrees([0, 90, 0])) : IDENTITY_BASIS,
      },
      subassemblyId: index < 4 ? 'chassis' : 'deck',
      stepId: index < 2 ? 'step_1' : index < 4 ? 'step_2' : 'step_3',
      provenance: index === 5 ? 'agent' : 'human',
      protected: index === 0,
      createdByTransaction: SECRETS.transaction,
    }
  })

  return {
    schemaVersion: 2,
    id: SECRETS.projectId,
    name: 'Survey Rover',
    revision,
    catalogVersion: '2026-07',
    createdAt: SECRETS.createdAt,
    updatedAt: SECRETS.updatedAt,
    parts,
    connections: {
      edge_1: {
        id: 'edge_1',
        a: { partId: 'part_001', featureId: 'stud_0' },
        b: { partId: 'part_003', featureId: 'antistud_0' },
        family: 'stud',
        joint: { kind: 'fixed' },
        createdAtRevision: 3,
        source: 'snap',
      },
      edge_2: {
        id: 'edge_2',
        a: { partId: 'part_002', featureId: 'stud_1' },
        b: { partId: 'part_004', featureId: 'antistud_1' },
        family: 'stud',
        joint: { kind: 'fixed' },
        createdAtRevision: 4,
        source: 'snap',
      },
      edge_3: {
        id: 'edge_3',
        a: { partId: 'part_003', featureId: 'stud_2' },
        b: { partId: 'part_005', featureId: 'antistud_2' },
        family: 'stud',
        joint: { kind: 'revolute', axis: [0, 1, 0], continuous: true },
        createdAtRevision: 6,
        source: 'explicit-connect',
      },
      // An edge to a part that does not exist: the serialiser must drop it
      // rather than publish a graph the viewer cannot draw.
      edge_orphan: {
        id: 'edge_orphan',
        a: { partId: 'part_001', featureId: 'stud_9' },
        b: { partId: 'part_missing', featureId: 'antistud_9' },
        family: 'stud',
        joint: { kind: 'unknown' },
        createdAtRevision: 7,
        source: 'import-inferred',
      },
    },
    subassemblies: {
      chassis: { id: 'chassis', name: 'Chassis', partIds: ['part_001', 'part_002', 'part_003', 'part_004'], locked: true, accent: '#6bbbd6' },
      deck: { id: 'deck', name: 'Equipment deck', partIds: ['part_005', 'part_006'], locked: false, accent: '#8bcf65' },
    },
    steps: [
      { id: 'step_1', index: 1, name: 'Chassis floor', partIds: ['part_001', 'part_002'] },
      { id: 'step_2', index: 2, name: 'Interlock layer', partIds: ['part_003', 'part_004'] },
      { id: 'step_3', index: 3, name: 'Deck', partIds: ['part_005', 'part_006'] },
    ],
    notes: [
      {
        id: 'note_1',
        anchorPartIds: ['part_001'],
        text: SECRETS.note,
        status: 'open',
        author: 'human',
        revisionCreated: 5,
        response: SECRETS.noteResponse,
      },
    ],
    constraints: [
      {
        id: 'constraint_1',
        kind: 'piece-count',
        label: SECRETS.constraintLabel,
        value: { max: 40, brief: SECRETS.prompt, assetUrl: SECRETS.signedUrl },
        hard: true,
      },
    ],
    modules: [
      {
        id: 'module_1',
        name: SECRETS.moduleName,
        parts: [{ definitionId: '3001', color: 4, transform: { position: [0, 0, 0], basis: IDENTITY_BASIS } }],
        sizeLdu: [20, 24, 20],
        createdAtRevision: 8,
        author: 'agent',
      },
    ],
  }
}

/** A hostile document: every free-text field is an injection attempt. */
export function hostileDocument(): ModelDocument {
  const document = privateDocument(3)
  document.name = '<img src=x onerror=alert(1)>Rover</script>'
  document.subassemblies.chassis.name = '</style><script>alert("sub")</script>'
  document.steps[0].name = '"><svg onload=alert(2)>'
  document.catalogVersion = '2026-07"><script>alert(3)</script>'
  return document
}

/** A healthy validation report for a given revision. */
export function healthyValidation(revision: number, partCount = 6): ValidationReport {
  return {
    revision,
    partCount,
    connectionCount: 3,
    collisions: [],
    unverifiedCollisions: 0,
    componentCount: 1,
    disconnectedPartIds: [],
    virtualColors: [],
    bounds: { min: [0, -60, 0], max: [60, 12, 60], size: [60, 72, 60] },
    constraints: [{ id: 'constraint_1', label: SECRETS.constraintLabel, status: 'pass', message: '6 / 40 parts' }],
    healthy: true,
  }
}
