import { ContactShadows, GizmoHelper, GizmoViewport, Grid, OrbitControls, OrthographicCamera, PerspectiveCamera, TransformControls } from '@react-three/drei'
import { Canvas, type ThreeEvent, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { catalog, STUD_LDU } from '../cad/catalog'
import { getDocumentBounds, snapTransformPosition } from '../cad/geometry'
import { canonicalTransform, orthonormalize } from '../cad/math'
import { getWorldConnectors } from '../cad/snapping'
import type { ModelDocument, PartInstance, Proposal, Transform, Vec3 } from '../cad/types'
import { validateDocument } from '../cad/validation'
import { PartVisual, type PartAppearance } from './PartVisual'

export type EditorTool = 'select' | 'move' | 'rotate' | 'connect'
export type CameraView = 'isometric' | 'front' | 'rear' | 'left' | 'right' | 'top'
export type RenderMode = 'beauty' | 'orthographic' | 'silhouette' | 'connections' | 'violations' | 'exploded'

/**
 * The CAD document is stored in LDraw's own frame: LDU units, Y increasing
 * downward. Rather than converting every value, the whole model hangs off one
 * root node that rotates 180° about X and scales LDU into scene units. Children
 * therefore use raw document coordinates, and `TransformControls` hands back
 * positions already in LDU.
 */
const MODEL_ROOT_ROTATION: [number, number, number] = [Math.PI, 0, 0]
const MODEL_ROOT_SCALE = 1 / STUD_LDU

/** Maps a document-space point into scene space for cameras and overlays. */
const lduToScene = (point: Vec3): THREE.Vector3 =>
  new THREE.Vector3(point[0] * MODEL_ROOT_SCALE, -point[1] * MODEL_ROOT_SCALE, -point[2] * MODEL_ROOT_SCALE)

/**
 * Builds the scene matrix for a document transform.
 *
 * The document holds a row-major LDraw basis; three.js wants column-major, and
 * `Matrix4.set` takes row-major arguments, so the basis columns are passed as
 * the matrix's rows' first three entries in the order three.js expects.
 */
function sceneMatrix(transform: Transform): THREE.Matrix4 {
  const b = transform.basis
  const [x, y, z] = transform.position
  return new THREE.Matrix4().set(
    b[0], b[1], b[2], x,
    b[3], b[4], b[5], y,
    b[6], b[7], b[8], z,
    0, 0, 0, 1,
  )
}

/** Reads a document transform back out of a scene object's local matrix. */
function documentTransform(object: THREE.Object3D): Transform {
  const m = object.matrix.elements
  // three.js stores column-major, so element (row, col) is elements[col * 4 + row].
  return {
    position: [m[12], m[13], m[14]],
    basis: orthonormalize([m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]),
  }
}

interface PartObjectProps {
  part: PartInstance
  appearance: PartAppearance
  canTransform: boolean
  tool: EditorTool
  gridLdu: number
  displayTransform?: Transform
  onSelect: (partId: string, additive: boolean, subassembly: boolean) => void
  onTransform: (partId: string, transform: Transform) => void
}

function PartObject({ part, appearance, canTransform, tool, gridLdu, displayTransform, onSelect, onTransform }: PartObjectProps) {
  const root = useRef<THREE.Group>(null)
  const definition = catalog.get(part.definitionId)
  if (!definition) return null

  const rendered = displayTransform ?? part.transform
  const handlePointer = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    onSelect(part.id, event.nativeEvent.shiftKey, event.nativeEvent.detail > 1)
  }

  const object = (
    <group
      ref={root}
      matrixAutoUpdate={false}
      matrix={sceneMatrix(rendered)}
      onPointerDown={handlePointer}
      onDoubleClick={(event) => {
        event.stopPropagation()
        onSelect(part.id, false, true)
      }}
    >
      <PartVisual definition={definition} colorCode={part.color} appearance={appearance} />
    </group>
  )

  if (!canTransform || (tool !== 'move' && tool !== 'rotate')) return object

  return (
    <TransformControls
      mode={tool === 'rotate' ? 'rotate' : 'translate'}
      space={tool === 'rotate' ? 'local' : 'world'}
      rotationSnap={Math.PI / 12}
      size={0.72}
      onMouseUp={() => {
        const object3d = root.current
        if (!object3d) return
        // The model root already works in LDU, so the manipulated matrix comes
        // back in document space. Only the translation is quantized; the basis
        // is taken as-is so an off-axis pose survives a drag.
        object3d.updateMatrix()
        const dragged = documentTransform(object3d)
        onTransform(part.id, {
          position: snapTransformPosition(dragged.position, gridLdu),
          basis: dragged.basis,
        })
      }}
    >
      {object}
    </TransformControls>
  )
}

function GhostProposal({ proposal, current }: { proposal: Proposal; current: ModelDocument }) {
  const added = Object.values(proposal.previewDocument.parts).filter((part) => {
    const original = current.parts[part.id]
    return (
      !original ||
      original.color !== part.color ||
      canonicalTransform(original.transform) !== canonicalTransform(part.transform)
    )
  })
  const removed = Object.values(current.parts).filter((part) => !proposal.previewDocument.parts[part.id])

  return (
    <group>
      {added.map((part) => {
        const definition = catalog.get(part.definitionId)
        if (!definition) return null
        return (
          <group key={`ghost_${part.id}`} matrixAutoUpdate={false} matrix={sceneMatrix(part.transform)}>
            <PartVisual definition={definition} colorCode={part.color} appearance="ghost" />
          </group>
        )
      })}
      {removed.map((part) => {
        const definition = catalog.get(part.definitionId)
        if (!definition) return null
        return (
          <group key={`removed_${part.id}`} matrixAutoUpdate={false} matrix={sceneMatrix(part.transform)}>
            <PartVisual definition={definition} colorCode={part.color} appearance="removed" />
          </group>
        )
      })}
    </group>
  )
}

function CameraRig({ document, view }: { document: ModelDocument; view: CameraView }) {
  const controls = useRef<OrbitControlsImpl>(null)
  // The camera comes from the R3F store rather than the controls ref: the ref is
  // not attached yet on the first commit, and this effect's dependencies would
  // not change again, so reading it there left the camera at its default
  // position inside the model.
  const { camera, size } = useThree()
  const bounds = useMemo(() => getDocumentBounds(document), [document])

  useEffect(() => {
    const center = lduToScene([
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ])
    const extent = Math.max(...bounds.size.map((amount) => amount * MODEL_ROOT_SCALE), 8)
    const distance = Math.max(24, extent * 2.05)
    const directions: Record<CameraView, THREE.Vector3> = {
      isometric: new THREE.Vector3(0.86, 0.64, 1),
      front: new THREE.Vector3(0, 0.25, 1),
      rear: new THREE.Vector3(0, 0.25, -1),
      left: new THREE.Vector3(-1, 0.25, 0),
      right: new THREE.Vector3(1, 0.25, 0),
      top: new THREE.Vector3(0, 1, 0.001),
    }
    camera.position.copy(center.clone().add(directions[view].normalize().multiplyScalar(distance)))
    camera.lookAt(center)
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      ;(camera as THREE.OrthographicCamera).zoom = Math.max(8, Math.min(size.width, size.height) / (extent * 1.9))
    }
    camera.updateProjectionMatrix()
    if (controls.current) {
      controls.current.target.copy(center)
      controls.current.update()
    }
  }, [bounds, camera, size.height, size.width, view])

  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.08} minDistance={3} maxDistance={400} />
}

interface CadViewportProps {
  document: ModelDocument
  selection: string[]
  proposals: Proposal[]
  tool: EditorTool
  gridLdu: number
  cameraView: CameraView
  renderMode: RenderMode
  onSelect: (partId: string, additive: boolean, subassembly: boolean) => void
  onClearSelection: () => void
  onTransform: (partId: string, transform: Transform) => void
  onCanvasReady?: (canvas: HTMLCanvasElement) => void
}

export function CadViewport({
  document,
  selection,
  proposals,
  tool,
  gridLdu,
  cameraView,
  renderMode,
  onSelect,
  onClearSelection,
  onTransform,
  onCanvasReady,
}: CadViewportProps) {
  const validation = useMemo(() => validateDocument(document), [document])
  const invalidIds = useMemo(
    () => new Set(validation.collisions.flatMap((issue) => [issue.partA, issue.partB])),
    [validation.collisions],
  )
  const subassemblyOrder = useMemo(() => Object.keys(document.subassemblies), [document.subassemblies])
  const selected = useMemo(() => new Set(selection), [selection])

  return (
    <Canvas
      shadows
      dpr={[1, 1.65]}
      gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.setClearColor('#0b1012')
        gl.outputColorSpace = THREE.SRGBColorSpace
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = 1.08
        onCanvasReady?.(gl.domElement)
      }}
      onPointerMissed={() => onClearSelection()}
    >
      {renderMode === 'orthographic'
        ? <OrthographicCamera makeDefault near={0.1} far={2000} zoom={28} />
        : <PerspectiveCamera makeDefault fov={34} near={0.1} far={2000} />}

      <ambientLight intensity={0.85} color="#b8ced3" />
      <directionalLight
        position={[-14, 22, 12]}
        intensity={3.1}
        color="#ffffff"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
      />
      <directionalLight position={[16, 10, -16]} intensity={1.6} color="#8cddeb" />

      <group rotation={MODEL_ROOT_ROTATION} scale={MODEL_ROOT_SCALE}>
        {Object.values(document.parts).map((part) => {
          const subassemblyIndex = Math.max(0, subassemblyOrder.indexOf(part.subassemblyId))
          const angle = (subassemblyIndex / Math.max(1, subassemblyOrder.length)) * Math.PI * 2
          const displayTransform: Transform | undefined =
            renderMode === 'exploded'
              ? {
                  ...part.transform,
                  position: [
                    part.transform.position[0] + Math.cos(angle) * 140,
                    part.transform.position[1] - (subassemblyIndex % 3) * 40,
                    part.transform.position[2] + Math.sin(angle) * 140,
                  ] as Vec3,
                }
              : undefined

          const appearance: PartAppearance =
            renderMode === 'violations' && invalidIds.has(part.id)
              ? 'invalid'
              : renderMode === 'silhouette'
                ? 'silhouette'
                : selected.has(part.id)
                  ? 'selected'
                  : 'solid'

          return (
            <PartObject
              key={part.id}
              part={part}
              appearance={appearance}
              canTransform={selection.length === 1 && selection[0] === part.id && renderMode === 'beauty'}
              tool={tool}
              gridLdu={gridLdu}
              displayTransform={displayTransform}
              onSelect={onSelect}
              onTransform={onTransform}
            />
          )
        })}

        {proposals
          .filter((proposal) => proposal.status === 'pending')
          .map((proposal) => (
            <GhostProposal key={proposal.id} proposal={proposal} current={document} />
          ))}

        {renderMode === 'connections' &&
          Object.values(document.parts).flatMap((part) =>
            getWorldConnectors(part).map((feature) => (
              <mesh key={`${feature.partId}_${feature.id}`} position={feature.frame.position as unknown as [number, number, number]}>
                <sphereGeometry args={[2.4, 10, 10]} />
                <meshBasicMaterial
                  color={feature.gender === 'male' ? '#f4aa45' : '#7cefe7'}
                  depthTest={false}
                  transparent
                  opacity={0.9}
                />
              </mesh>
            )),
          )}
      </group>

      <Grid
        position={[0, -0.02, 0]}
        args={[240, 240]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#253135"
        sectionSize={4}
        sectionThickness={1.15}
        sectionColor="#3a4d51"
        fadeDistance={110}
        fadeStrength={1.6}
        infiniteGrid
      />
      <ContactShadows position={[0, -0.014, 0]} scale={70} opacity={0.44} blur={2.6} far={26} resolution={1024} color="#000000" />
      <CameraRig document={document} view={cameraView} />
      <GizmoHelper alignment="bottom-right" margin={[76, 76]}>
        <GizmoViewport axisColors={['#ff6a55', '#8bcf65', '#6bbbd6']} labelColor="#0c1112" />
      </GizmoHelper>
      <fog attach="fog" args={['#0b1012', 90, 220]} />
    </Canvas>
  )
}
