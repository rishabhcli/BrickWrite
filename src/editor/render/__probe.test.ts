import { writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { findArticulatedJoints } from '../../cad/articulation'
import { CadEngine } from '../../cad/engine'
import { getPartBounds } from '../../cad/geometry'
import { IDENTITY_BASIS } from '../../cad/math'
import { createEmptyDocument } from '../../cad/sample'
import type { CadOperation, PartInstance } from '../../cad/types'
import { previewTransforms } from './jointDrag'

const part = (id: string, definitionId: string, position: [number, number, number]): PartInstance => ({
  id, definitionId, color: 71, transform: { position, basis: IDENTITY_BASIS },
  subassemblyId: 'hull', stepId: 'step_1', provenance: 'human', protected: false,
})

const lines: string[] = []
const log = (...args: unknown[]) => lines.push(args.map((a) => JSON.stringify(a)).join(' '))

describe('probe', () => {
  it('prints hinge geometry', () => {
    const engine = new CadEngine(createEmptyDocument())
    let revision = engine.getSnapshot().document.revision
    for (const item of [part('base', '3937', [0, 0, 0]), part('flap', '3938', [0, 0, 0])]) {
      const ops: CadOperation[] = [{ type: 'part.add', part: item }]
      const r = engine.execute('p', ops, 'human', revision)
      if (r.ok) revision = r.value.resultRevision
    }
    const document = engine.getSnapshot().document
    const joints = findArticulatedJoints(document, ['flap'])
    log('joints', joints.map((j) => ({ kind: j.joint.kind, axis: j.axis, pivot: j.pivotLdu, moving: j.movingPartIds })))
    const joint = joints[0]
    for (const angle of [0, 45, 80, 90, 160]) {
      const posed = previewTransforms(document, joint, { rotateDegrees: angle, slideLdu: 0 }).get('flap')
      const bounds = getPartBounds({ ...document.parts.flap, transform: posed ?? document.parts.flap.transform })
      log(angle, 'pos', posed?.position.map((v) => Math.round(v * 10) / 10), 'bounds', bounds.min.map(Math.round), bounds.max.map(Math.round))
    }
    const b3001 = getPartBounds(part('w', '3001', [0, 0, 0]))
    log('3001 bounds', b3001.min, b3001.max)
    writeFileSync('/tmp/probe.txt', lines.join('\n'))
  })
})
