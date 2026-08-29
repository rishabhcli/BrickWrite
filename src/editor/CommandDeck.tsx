import {
  Blocks,
  Boxes,
  Check,
  Command,
  Copy,
  FilePenLine,
  FlipHorizontal2,
  GitBranch,
  Grid3X3,
  Hash,
  Layers3,
  Link2,
  Lock,
  MessageSquare,
  Move3d,
  Palette,
  Repeat2,
  Ruler,
  Rotate3d,
  Search,
  Sparkles,
  Trash2,
  Unlock,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { findArticulatedJoints } from '../cad/articulation'
import { getColor } from '../cad/catalog'
import { describeModule, documentModules } from '../cad/modules'
import {
  SHARED_MUTATION_CAPABILITIES,
  type SharedMutationId,
} from '../cad/capabilities'
import type { EngineSnapshot, JointFreedom } from '../cad/types'

interface CommandDeckProps {
  open: boolean
  state: EngineSnapshot
  onClose: () => void
  onRun: (capability: SharedMutationId, args?: Record<string, unknown>) => boolean
  initialCapability?: SharedMutationId
}

const GROUP_ORDER = ['assemble', 'project', 'transform', 'mechanism', 'structure', 'constraints', 'collaborate', 'sequence'] as const

/** Everyday building colours offered to the generators, in LDraw code order. */
const BUILD_COLORS = [15, 71, 72, 0, 4, 14, 1, 2, 25, 320, 191, 27, 70, 47]
const SELECTION_ACTIONS = new Set<SharedMutationId>([
  'duplicate_selection',
  'mirror_selection',
  'linear_array',
  'assign_subassembly',
  'add_builder_note',
])

const groupIcon = (group: string): ReactNode => {
  if (group === 'assemble') return <Blocks size={14} />
  if (group === 'project') return <FilePenLine size={14} />
  if (group === 'transform') return <Move3d size={14} />
  if (group === 'mechanism') return <GitBranch size={14} />
  if (group === 'structure') return <Layers3 size={14} />
  if (group === 'constraints') return <Ruler size={14} />
  if (group === 'collaborate') return <MessageSquare size={14} />
  return <Grid3X3 size={14} />
}

const actionIcon = (id: SharedMutationId): ReactNode => {
  if (id === 'duplicate_selection') return <Copy size={15} />
  if (id === 'mirror_selection') return <FlipHorizontal2 size={15} />
  if (id === 'linear_array') return <Repeat2 size={15} />
  if (id === 'connect_parts') return <Link2 size={15} />
  if (id === 'articulate_joint') return <Rotate3d size={15} />
  if (id === 'lock_subassembly') return <Lock size={15} />
  if (id === 'add_builder_note' || id === 'respond_to_note') return <MessageSquare size={15} />
  if (id === 'apply_build_order') return <Grid3X3 size={15} />
  if (id === 'rename_document') return <FilePenLine size={15} />
  if (id === 'set_dimension_limit') return <Ruler size={15} />
  if (id === 'set_piece_budget') return <Hash size={15} />
  if (id === 'set_palette') return <Palette size={15} />
  if (id === 'remove_constraint') return <Trash2 size={15} />
  return <Boxes size={15} />
}

function jointCanRotate(joint: JointFreedom | undefined) {
  return joint?.kind === 'revolute' || joint?.kind === 'cylindrical' || joint?.kind === 'spherical'
}

function jointCanSlide(joint: JointFreedom | undefined) {
  return joint?.kind === 'prismatic' || joint?.kind === 'cylindrical'
}

/**
 * The human surface for the exact long-tail capability registry WebMCP sees.
 * It intentionally looks like an operator console, not an AI chat box: every
 * control is deterministic, unit-labelled and commits through CadEngine.
 */
export function CommandDeck({ open, state, onClose, onRun, initialCapability }: CommandDeckProps) {
  const deck = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<SharedMutationId>('duplicate_selection')
  const [offset, setOffset] = useState<[number, number, number]>([20, 0, 0])
  const [copies, setCopies] = useState(3)
  const [axis, setAxis] = useState(0)
  const [movingPartId, setMovingPartId] = useState('')
  const [targetPartId, setTargetPartId] = useState('')
  const [jointId, setJointId] = useState('')
  const [rotateDegrees, setRotateDegrees] = useState(15)
  const [slideLdu, setSlideLdu] = useState(4)
  const [newSubassembly, setNewSubassembly] = useState('New module')
  const [accent, setAccent] = useState('#e79032')
  const [includeSelection, setIncludeSelection] = useState(true)
  const [subassemblyId, setSubassemblyId] = useState('')
  const [subassemblyName, setSubassemblyName] = useState('')
  const [noteText, setNoteText] = useState('')
  const [noteId, setNoteId] = useState('')
  const [noteResponse, setNoteResponse] = useState('')
  const [resolveNote, setResolveNote] = useState(true)
  const [maxPartsPerStep, setMaxPartsPerStep] = useState(6)
  const [projectName, setProjectName] = useState(state.document.name)
  // Design-constraint editors. These are the operator's side of the gate the
  // kernel enforces on every commit: when a hard constraint refuses an edit, the
  // refusal says to soften or remove it, and this is where that happens.
  const [widthStuds, setWidthStuds] = useState(32)
  const [depthStuds, setDepthStuds] = useState(32)
  // 0 means "no ceiling", matching the optional `height` the constraint carries.
  const [heightStuds, setHeightStuds] = useState(0)
  const [maxParts, setMaxParts] = useState(500)
  const [paletteText, setPaletteText] = useState('')
  const [constraintHard, setConstraintHard] = useState(true)
  const [constraintId, setConstraintId] = useState('')
  // Parametric assembly. Defaults describe a small building storey rather than
  // a degenerate one, so the first run produces something worth looking at.
  const [runStuds, setRunStuds] = useState(16)
  const [runDepthStuds, setRunDepthStuds] = useState(12)
  const [courses, setCourses] = useState(4)
  const [wallAxis, setWallAxis] = useState<'x' | 'z'>('x')
  const [wallFamily, setWallFamily] = useState<'brick' | 'plate' | 'tile'>('brick')
  const [wallDepth, setWallDepth] = useState(1)
  const [buildColor, setBuildColor] = useState(71)
  const [withFloor, setWithFloor] = useState(true)
  const [rigidFloor, setRigidFloor] = useState(true)
  const [withDoor, setWithDoor] = useState(true)
  const [doorWidth, setDoorWidth] = useState(0)
  const [storeys, setStoreys] = useState(3)
  const [windowsPerSide, setWindowsPerSide] = useState(2)
  // -1 means "no contrasting band", which the capability treats as absent.
  const [bandColor, setBandColor] = useState(15)
  const [moduleName, setModuleName] = useState('')
  const [moduleId, setModuleId] = useState('')
  const [stampAt, setStampAt] = useState<[number, number, number]>([0, 0, 0])
  const [stampTurns, setStampTurns] = useState(0)
  const [stampCopies, setStampCopies] = useState(1)

  const parts = useMemo(() => Object.values(state.document.parts), [state.document.parts])
  const modules = useMemo(() => documentModules(state.document), [state.document])
  const subassemblies = useMemo(() => Object.values(state.document.subassemblies), [state.document.subassemblies])
  const openNotes = useMemo(() => state.document.notes.filter((note) => note.status === 'open'), [state.document.notes])
  const joints = useMemo(
    () => findArticulatedJoints(state.document, state.selection),
    [state.document, state.selection],
  )
  const selectedJoint = joints.find((joint) => joint.edgeId === jointId) ?? joints[0]
  const constraints = state.document.constraints
  // The capability takes integer LDraw colour codes, so the field is parsed the
  // same way rather than trusted: anything non-numeric simply does not count.
  const paletteCodes = useMemo(
    () => [...new Set(paletteText.split(/[^0-9]+/).filter(Boolean).map(Number))],
    [paletteText],
  )
  const constraintStatus = (id: string) => state.validation.constraints.find((entry) => entry.id === id)

  useEffect(() => {
    if (!open) return
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setProjectName(state.document.name)
    const selected = state.selection
    setMovingPartId(selected[0] ?? '')
    setTargetPartId(selected[1] ?? '')
    const selectedPart = state.document.parts[selected[0] ?? '']
    setSubassemblyId(selectedPart?.subassemblyId ?? subassemblies[0]?.id ?? '')
    setNoteId(openNotes[0]?.id ?? '')
    if (initialCapability) setActive(initialCapability)
    setJointId(joints[0]?.edgeId ?? '')
    const dimensions = state.document.constraints.find((constraint) => constraint.kind === 'dimensions')
    const envelope = dimensions?.value as { width?: number; depth?: number; height?: number } | undefined
    setWidthStuds(envelope?.width ?? 32)
    setDepthStuds(envelope?.depth ?? 32)
    setHeightStuds(envelope?.height ?? 0)
    const budget = state.document.constraints.find((constraint) => constraint.kind === 'piece-count')
    setMaxParts(Number(budget?.value) || 500)
    const palette = state.document.constraints.find((constraint) => constraint.kind === 'palette')
    setPaletteText(Array.isArray(palette?.value) ? (palette.value as number[]).join(', ') : '')
    setConstraintHard(dimensions?.hard ?? budget?.hard ?? true)
    setConstraintId(state.document.constraints[0]?.id ?? '')
    setModuleId(documentModules(state.document)[0]?.id ?? '')
    requestAnimationFrame(() => search.current?.focus())
    return () => {
      returnFocus.current?.focus()
      returnFocus.current = null
    }
    // Opening establishes a snapshot. Live document changes continue to flow
    // through the memoized collections without stealing focus.
     
  }, [open])

  useEffect(() => {
    const subassembly = state.document.subassemblies[subassemblyId]
    setSubassemblyName(subassembly?.name ?? '')
  }, [state.document.subassemblies, subassemblyId])

  useEffect(() => {
    if (jointId && joints.some((joint) => joint.edgeId === jointId)) return
    setJointId(joints[0]?.edgeId ?? '')
  }, [jointId, joints])

  const filtered = SHARED_MUTATION_CAPABILITIES.filter((capability) =>
    `${capability.title} ${capability.summary} ${capability.group}`.toLowerCase().includes(query.trim().toLowerCase()),
  )
  const current = SHARED_MUTATION_CAPABILITIES.find((capability) => capability.id === active)!

  const argsFor = (): Record<string, unknown> => {
    switch (active) {
      case 'duplicate_selection': return { offsetLdu: offset }
      case 'mirror_selection': return { axisLdu: axis }
      case 'linear_array': return { copies, offsetLdu: offset }
      case 'connect_parts': return { movingPartId, targetPartId }
      case 'articulate_joint': return {
        edgeId: selectedJoint?.edgeId,
        ...(jointCanRotate(selectedJoint?.joint) ? { rotateDegrees } : {}),
        ...(jointCanSlide(selectedJoint?.joint) ? { slideLdu } : {}),
      }
      case 'create_subassembly': return { name: newSubassembly, accent, partIds: includeSelection ? state.selection : [] }
      case 'assign_subassembly': return { subassemblyId }
      case 'rename_subassembly': return { subassemblyId, name: subassemblyName }
      case 'lock_subassembly': return { subassemblyId, locked: !state.document.subassemblies[subassemblyId]?.locked }
      case 'add_builder_note': return { text: noteText }
      case 'respond_to_note': return { noteId, response: noteResponse, resolved: resolveNote }
      case 'apply_build_order': return { maxPartsPerStep }
      case 'rename_document': return { name: projectName }
      case 'set_dimension_limit': return {
        widthStuds,
        depthStuds,
        // Omitted rather than zeroed: the constraint treats an absent height as
        // unbounded, and `positive()` would reject a 0.
        ...(heightStuds > 0 ? { heightStuds } : {}),
        hard: constraintHard,
      }
      case 'set_piece_budget': return { maxParts, hard: constraintHard }
      case 'set_palette': return { colors: paletteCodes, hard: constraintHard }
      case 'remove_constraint': return { constraintId }
      case 'build_wall': return {
        lengthStuds: runStuds,
        courses,
        axis: wallAxis,
        family: wallFamily,
        depthStuds: wallDepth,
        color: buildColor,
        ...(doorWidth > 0
          ? { openings: [{ atStud: Math.max(0, Math.floor((runStuds - doorWidth) / 2)), widthStuds: doorWidth, fromCourse: 0, toCourse: Math.max(0, courses - 2) }] }
          : {}),
      }
      case 'build_enclosure': return {
        widthStuds: runStuds,
        depthStuds: runDepthStuds,
        courses,
        family: wallFamily === 'tile' ? 'brick' : wallFamily,
        wallDepthStuds: wallDepth,
        color: buildColor,
        floor: withFloor,
        floorLayers: rigidFloor ? 2 : 1,
        ...(doorWidth > 0
          ? { openings: [{ atStud: Math.max(0, Math.floor((runStuds - doorWidth) / 2)), widthStuds: doorWidth, fromCourse: 0, toCourse: Math.max(0, courses - 2) }] }
          : {}),
      }
      case 'build_field': return { widthStuds: runStuds, depthStuds: runDepthStuds, layers: rigidFloor ? 2 : 1, family: wallFamily === 'brick' ? 'plate' : wallFamily, color: buildColor }
      case 'build_hinged_flap': return { widthStuds: runStuds, reachStuds: runDepthStuds, color: buildColor }
      case 'stack_selection': return { copies: storeys }
      case 'build_structure': return {
        widthStuds: runStuds,
        depthStuds: runDepthStuds,
        storeys,
        coursesPerStorey: courses,
        color: buildColor,
        ...(bandColor >= 0 ? { bandColor } : {}),
        windowsPerSide,
        windowWidthStuds: 2,
        door: withDoor,
        }
      case 'capture_module': return { name: moduleName }
      case 'stamp_module': return { module: moduleId, atLdu: stampAt, quarterTurns: stampTurns, copies: stampCopies }
      case 'remove_module': return { module: moduleId }
    }
  }

  const disabledReason = (() => {
    if (SELECTION_ACTIONS.has(active) && !state.selection.length) return 'Select at least one part first.'
    if (active === 'connect_parts' && (!movingPartId || !targetPartId || movingPartId === targetPartId)) return 'Choose two different parts.'
    if (active === 'articulate_joint' && !selectedJoint) return 'Select a part attached to a drivable joint.'
    if ((active === 'assign_subassembly' || active === 'rename_subassembly' || active === 'lock_subassembly') && !subassemblyId) return 'No subassembly is available.'
    if (active === 'add_builder_note' && !noteText.trim()) return 'Write a note for the selection.'
    if (active === 'respond_to_note' && (!noteId || !noteResponse.trim())) return 'Choose a note and write a response.'
    if (active === 'create_subassembly' && !newSubassembly.trim()) return 'Name the new subassembly.'
    if (active === 'rename_subassembly' && !subassemblyName.trim()) return 'Name the subassembly.'
    if (active === 'rename_document' && !projectName.trim()) return 'Name the project.'
    if (active === 'set_dimension_limit' && (widthStuds <= 0 || depthStuds <= 0)) return 'Width and depth must be positive.'
    if (active === 'set_palette' && (!paletteCodes.length || paletteCodes.length > 64)) return 'List 1–64 LDraw colour codes.'
    if (active === 'remove_constraint' && !constraintId) return 'Choose a constraint to remove.'
    return null
  })()

  if (!open) return null

  const execute = () => {
    if (disabledReason) return
    const succeeded = onRun(active, argsFor())
    if (succeeded && active === 'add_builder_note') setNoteText('')
    if (succeeded && active === 'respond_to_note') setNoteResponse('')
  }

  return (
    <div className="command-deck-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        ref={deck}
        className="command-deck"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-deck-title"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const focusable = [...(deck.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? [])]
          if (!focusable.length) return
          const first = focusable[0]
          const last = focusable.at(-1)!
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header className="command-deck-header">
          <div className="command-deck-identity">
            <span className="command-glyph"><Command size={18} /></span>
            <div>
              <span className="eyebrow">UNIFIED CONTROL PLANE / REV {state.document.revision}</span>
              <h2 id="command-deck-title">Command Deck</h2>
            </div>
          </div>
          <div className="operator-parity" aria-label="Human and agent capability parity">
            <span><i className="human-lane" /> HUMAN</span>
            <b><Sparkles size={11} /> SAME KERNEL</b>
            <span><i className="agent-lane" /> AGENT</span>
          </div>
          <button className="command-close" onClick={onClose} aria-label="Close command deck"><X size={16} /></button>
        </header>

        <div className="command-deck-body">
          <aside className="command-index" aria-label="Shared CAD capabilities">
            <label className="command-search">
              <Search size={13} />
              <input ref={search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a command…" />
              <kbd>⌘/</kbd>
            </label>
            <div className="command-scope">
              <span>ACTIVE SCOPE</span>
              <strong>{state.selection.length ? `${state.selection.length} selected` : 'No selection'}</strong>
              <small>{state.selection.length ? state.selection.slice(0, 2).join(' · ') : 'Select in the viewport or use project commands.'}</small>
            </div>
            <div className="command-list">
              {GROUP_ORDER.map((group) => {
                const actions = filtered.filter((capability) => capability.group === group)
                if (!actions.length) return null
                return (
                  <section key={group}>
                    <h3>{groupIcon(group)} {group}</h3>
                    {actions.map((capability) => (
                      <button
                        key={capability.id}
                        className={active === capability.id ? 'active' : ''}
                        onClick={() => setActive(capability.id)}
                      >
                        <span>{actionIcon(capability.id)}</span>
                        <div><strong>{capability.title}</strong><small>{capability.summary}</small></div>
                        <i />
                      </button>
                    ))}
                  </section>
                )
              })}
              {!filtered.length && <div className="command-empty"><Search size={18} /><strong>No deterministic command found</strong><small>Try “array”, “note”, “joint” or “project”.</small></div>}
            </div>
          </aside>

          <article className="command-workbench" data-capability={active}>
            <div className="command-title">
              <span className="command-action-icon">{actionIcon(active)}</span>
              <div><span className="eyebrow">{current.group} / {current.id}</span><h3>{current.title}</h3><p>{current.summary}</p></div>
            </div>

            <div className="command-control-sheet">
              {(active === 'duplicate_selection' || active === 'linear_array') && (
                <>
                  {active === 'linear_array' && <NumberControl label="Additional copies" value={copies} min={1} max={24} onChange={setCopies} />}
                  <VectorControl label="Exact offset" value={offset} onChange={setOffset} />
                </>
              )}
              {active === 'mirror_selection' && <NumberControl label="Mirror plane X" value={axis} suffix="LDU" onChange={setAxis} />}
              {active === 'build_hinged_flap' && (
                <>
                  <div className="command-grid">
                    <NumberControl label="Hinge width" value={runStuds} min={2} max={64} suffix="studs" onChange={setRunStuds} />
                    <NumberControl label="Flap reach" value={runDepthStuds} min={1} max={64} suffix="studs" onChange={setRunDepthStuds} />
                  </div>
                  <SelectControl
                    label="Colour"
                    value={String(buildColor)}
                    onChange={(value) => setBuildColor(Number(value))}
                    options={BUILD_COLORS.map((code) => ({ value: String(code), label: getColor(code).name }))}
                  />
                  <p className="command-hint">
                    A hinge line and a plate panel. The joint is a real revolute in the connection graph, so the inspector — or
                    the agent — can swing it, and everything rigidly attached to the flap moves with it.
                  </p>
                </>
              )}
              {(active === 'build_wall' || active === 'build_enclosure' || active === 'build_field') && (
                <>
                  <div className="command-grid">
                    <NumberControl label={active === 'build_wall' ? 'Run' : 'Width'} value={runStuds} min={1} max={256} suffix="studs" onChange={setRunStuds} />
                    {active !== 'build_wall' && <NumberControl label="Depth" value={runDepthStuds} min={1} max={256} suffix="studs" onChange={setRunDepthStuds} />}
                    {active !== 'build_field' && <NumberControl label="Courses" value={courses} min={1} max={64} suffix="high" onChange={setCourses} />}
                  </div>
                  <div className="command-grid">
                    <SelectControl
                      label="Part family"
                      value={wallFamily}
                      onChange={(value) => setWallFamily(value as 'brick' | 'plate' | 'tile')}
                      options={[{ value: 'brick', label: 'Bricks' }, { value: 'plate', label: 'Plates' }, { value: 'tile', label: 'Tiles' }]}
                    />
                    {active !== 'build_field' && (
                      <SelectControl
                        label="Wall thickness"
                        value={String(wallDepth)}
                        onChange={(value) => setWallDepth(Number(value))}
                        options={[{ value: '1', label: '1 stud' }, { value: '2', label: '2 studs' }]}
                      />
                    )}
                    {active === 'build_wall' && (
                      <SelectControl label="Runs along" value={wallAxis} onChange={(value) => setWallAxis(value as 'x' | 'z')} options={[{ value: 'x', label: 'X axis' }, { value: 'z', label: 'Z axis' }]} />
                    )}
                  </div>
                  <SelectControl
                    label="Colour"
                    value={String(buildColor)}
                    onChange={(value) => setBuildColor(Number(value))}
                    options={BUILD_COLORS.map((code) => ({ value: String(code), label: getColor(code).name }))}
                  />
                  {active !== 'build_field' && (
                    <NumberControl label="Doorway width (0 for none)" value={doorWidth} min={0} max={64} suffix="studs" onChange={setDoorWidth} />
                  )}
                  {active === 'build_enclosure' && <ToggleControl checked={withFloor} onChange={setWithFloor} label="Lay a plate deck under the walls" />}
                  {(active === 'build_field' || (active === 'build_enclosure' && withFloor)) && (
                    <ToggleControl
                      checked={rigidFloor}
                      onChange={setRigidFloor}
                      label="Cross-bond the deck into a rigid slab (two layers)"
                    />
                  )}
                  <p className="command-hint">
                    Courses are staggered against each other and corners interlock. The result is one transaction, checked for
                    collisions by the kernel before it commits — and reversible with a single undo.
                  </p>
                </>
              )}
              {active === 'build_structure' && (
                <>
                  <div className="command-grid">
                    <NumberControl label="Width" value={runStuds} min={6} max={128} suffix="studs" onChange={setRunStuds} />
                    <NumberControl label="Depth" value={runDepthStuds} min={6} max={128} suffix="studs" onChange={setRunDepthStuds} />
                  </div>
                  <div className="command-grid">
                    <NumberControl label="Storeys" value={storeys} min={1} max={24} onChange={setStoreys} />
                    <NumberControl label="Courses per storey" value={courses} min={2} max={12} onChange={setCourses} />
                    <NumberControl label="Windows per side" value={windowsPerSide} min={0} max={8} onChange={setWindowsPerSide} />
                  </div>
                  <div className="command-grid">
                    <SelectControl
                      label="Wall colour"
                      value={String(buildColor)}
                      onChange={(value) => setBuildColor(Number(value))}
                      options={BUILD_COLORS.map((code) => ({ value: String(code), label: getColor(code).name }))}
                    />
                    <SelectControl
                      label="Band colour"
                      value={String(bandColor)}
                      onChange={(value) => setBandColor(Number(value))}
                      options={[{ value: '-1', label: 'No band' }, ...BUILD_COLORS.map((code) => ({ value: String(code), label: getColor(code).name }))]}
                    />
                  </div>
                  <ToggleControl checked={withDoor} onChange={setWithDoor} label="Put a door frame on the ground floor" />
                  <p className="command-hint">
                    One transaction: a deck and walls per storey, real window and door frames seated in the openings, a
                    contrasting band between storeys and a parapet on top. The kernel checks the whole thing for collisions
                    before it commits, and one undo takes it all back.
                  </p>
                </>
              )}
              {(active === 'capture_module' || active === 'stamp_module' || active === 'remove_module') && (
                <>
                  {active === 'capture_module' && (
                    <>
                      <TextControl label="Module name" value={moduleName} onChange={setModuleName} maxLength={80} />
                      <p className="command-hint">
                        The {state.selection.length} selected part{state.selection.length === 1 ? '' : 's'} are captured into their
                        own frame, so the module stamps onto the ground wherever it was built.
                      </p>
                    </>
                  )}
                  {active !== 'capture_module' && (
                    <SelectControl
                      label="Module"
                      value={moduleId}
                      onChange={setModuleId}
                      options={modules.map((module) => ({ value: module.id, label: `${module.name} · ${describeModule(module)}` }))}
                    />
                  )}
                  {active === 'stamp_module' && (
                    <>
                      <VectorControl label="Stamp at" value={stampAt} onChange={setStampAt} />
                      <div className="command-grid">
                        <NumberControl label="Quarter turns" value={stampTurns} min={0} max={3} onChange={setStampTurns} />
                        <NumberControl label="Copies" value={stampCopies} min={1} max={64} onChange={setStampCopies} />
                      </div>
                    </>
                  )}
                </>
              )}
              {active === 'stack_selection' && (
                <>
                  <NumberControl label="Additional storeys" value={storeys} min={1} max={32} suffix="copies" onChange={setStoreys} />
                  <p className="command-hint">
                    The selection is measured and repeated upward by its own height, snapped to the plate grid, so one storey
                    becomes a tower without working out the offset.
                  </p>
                </>
              )}
              {active === 'connect_parts' && (
                <div className="command-pair">
                  <SelectControl label="Moving part" value={movingPartId} onChange={setMovingPartId} options={parts.map((part) => ({ value: part.id, label: `${part.definitionId} · ${part.id}` }))} />
                  <span><Link2 size={16} /></span>
                  <SelectControl label="Target part" value={targetPartId} onChange={setTargetPartId} options={parts.map((part) => ({ value: part.id, label: `${part.definitionId} · ${part.id}` }))} />
                </div>
              )}
              {active === 'articulate_joint' && (
                <>
                  <SelectControl label="Persisted joint" value={selectedJoint?.edgeId ?? ''} onChange={setJointId} options={joints.map((joint) => ({ value: joint.edgeId, label: joint.label }))} />
                  {jointCanRotate(selectedJoint?.joint) && <NumberControl label="Rotation" value={rotateDegrees} suffix="°" onChange={setRotateDegrees} />}
                  {jointCanSlide(selectedJoint?.joint) && <NumberControl label="Axial travel" value={slideLdu} suffix="LDU" onChange={setSlideLdu} />}
                </>
              )}
              {active === 'create_subassembly' && (
                <>
                  <TextControl label="Subassembly name" value={newSubassembly} onChange={setNewSubassembly} maxLength={80} />
                  <label className="color-control"><span>Accent</span><input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} /><code>{accent}</code></label>
                  <ToggleControl checked={includeSelection} onChange={setIncludeSelection} label={`Move ${state.selection.length} selected part${state.selection.length === 1 ? '' : 's'} into it`} />
                </>
              )}
              {active === 'assign_subassembly' && <SelectControl label="Destination" value={subassemblyId} onChange={setSubassemblyId} options={subassemblies.map((item) => ({ value: item.id, label: `${item.name}${item.locked ? ' · LOCKED' : ''}` }))} />}
              {active === 'rename_subassembly' && (
                <><SelectControl label="Subassembly" value={subassemblyId} onChange={setSubassemblyId} options={subassemblies.map((item) => ({ value: item.id, label: item.name }))} /><TextControl label="New name" value={subassemblyName} onChange={setSubassemblyName} maxLength={80} /></>
              )}
              {active === 'lock_subassembly' && (
                <><SelectControl label="Subassembly" value={subassemblyId} onChange={setSubassemblyId} options={subassemblies.map((item) => ({ value: item.id, label: item.name }))} /><div className={`lock-preview ${state.document.subassemblies[subassemblyId]?.locked ? 'locked' : ''}`}>{state.document.subassemblies[subassemblyId]?.locked ? <><Lock size={17} /><div><strong>Currently locked</strong><small>Run to reopen this region for agent edits.</small></div></> : <><Unlock size={17} /><div><strong>Currently collaborative</strong><small>Run to make this a human-owned protected region.</small></div></>}</div></>
              )}
              {active === 'add_builder_note' && <TextAreaControl label="Spatial note" value={noteText} onChange={setNoteText} placeholder="Describe what must change—or what must never change." maxLength={800} />}
              {active === 'respond_to_note' && (
                <><SelectControl label="Open note" value={noteId} onChange={setNoteId} options={openNotes.map((note) => ({ value: note.id, label: note.text }))} /><TextAreaControl label="Response" value={noteResponse} onChange={setNoteResponse} placeholder="Record the decision in the model history." maxLength={1200} /><ToggleControl checked={resolveNote} onChange={setResolveNote} label="Resolve after responding" /></>
              )}
              {active === 'apply_build_order' && <NumberControl label="Maximum parts per step" value={maxPartsPerStep} min={1} max={100} onChange={setMaxPartsPerStep} />}
              {active === 'rename_document' && <TextControl label="Project name" value={projectName} onChange={setProjectName} maxLength={120} />}
              {active === 'set_dimension_limit' && (
                <>
                  <div className="command-pair-fields">
                    <NumberControl label="Maximum width" value={widthStuds} min={1} suffix="studs" onChange={setWidthStuds} />
                    <NumberControl label="Maximum depth" value={depthStuds} min={1} suffix="studs" onChange={setDepthStuds} />
                  </div>
                  <NumberControl label="Maximum height (0 = unbounded)" value={heightStuds} min={0} suffix="studs" onChange={setHeightStuds} />
                  <ConstraintStatus current={constraintStatus(constraints.find((constraint) => constraint.kind === 'dimensions')?.id ?? '')} />
                  <HardControl checked={constraintHard} onChange={setConstraintHard} />
                </>
              )}
              {active === 'set_piece_budget' && (
                <>
                  <NumberControl label="Maximum parts" value={maxParts} min={1} max={100_000} suffix="parts" onChange={setMaxParts} />
                  <ConstraintStatus current={constraintStatus(constraints.find((constraint) => constraint.kind === 'piece-count')?.id ?? '')} />
                  <HardControl checked={constraintHard} onChange={setConstraintHard} />
                </>
              )}
              {active === 'set_palette' && (
                <>
                  <TextControl label="Allowed LDraw colour codes" value={paletteText} onChange={setPaletteText} maxLength={400} />
                  <p className="command-hint">{paletteCodes.length ? `${paletteCodes.length} colour${paletteCodes.length === 1 ? '' : 's'}: ${paletteCodes.join(' · ')}` : 'Separate codes with commas or spaces, e.g. 72, 4, 15.'}</p>
                  <ConstraintStatus current={constraintStatus(constraints.find((constraint) => constraint.kind === 'palette')?.id ?? '')} />
                  <HardControl checked={constraintHard} onChange={setConstraintHard} />
                </>
              )}
              {active === 'remove_constraint' && (
                <>
                  <SelectControl
                    label="Constraint"
                    value={constraintId}
                    onChange={setConstraintId}
                    options={constraints.map((constraint) => ({ value: constraint.id, label: `${constraint.label} · ${constraint.hard ? 'HARD' : 'ADVISORY'}` }))}
                  />
                  <ConstraintStatus current={constraintStatus(constraintId)} />
                  {!constraints.length && <p className="command-hint">This project declares no design constraints.</p>}
                </>
              )}
            </div>

            <div className="command-proof-strip">
              <div><Check size={13} /><span><strong>ONE TRANSACTION</strong><small>Atomic at r{state.document.revision + 1}</small></span></div>
              <div><GitBranch size={13} /><span><strong>SAME PLANNER</strong><small>Human + WebMCP</small></span></div>
              <div><Lock size={13} /><span><strong>KERNEL GUARDED</strong><small>Locks · collisions · revision</small></span></div>
            </div>

            <footer className="command-actions">
              <div><span>AGENT EQUIVALENT</span><code>action_mutate({current.id})</code></div>
              <button onClick={onClose}>CANCEL</button>
              <button className="command-run" onClick={execute} disabled={Boolean(disabledReason)} title={disabledReason ?? `Run ${current.title}`}>
                <Sparkles size={14} /> RUN COMMAND
              </button>
            </footer>
            {disabledReason && <p className="command-disabled-reason">{disabledReason}</p>}
          </article>
        </div>
      </section>
    </div>
  )
}

function NumberControl({ label, value, onChange, suffix, min, max }: { label: string; value: number; onChange: (value: number) => void; suffix?: string; min?: number; max?: number }) {
  return <label className="command-field"><span>{label}</span><div><input type="number" value={value} min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <em>{suffix}</em>}</div></label>
}

function TextControl({ label, value, onChange, maxLength }: { label: string; value: string; onChange: (value: string) => void; maxLength: number }) {
  return <label className="command-field"><span>{label}</span><div><input type="text" value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} /></div></label>
}

function TextAreaControl({ label, value, onChange, maxLength, placeholder }: { label: string; value: string; onChange: (value: string) => void; maxLength: number; placeholder: string }) {
  return <label className="command-field command-textarea"><span>{label}<em>{value.length}/{maxLength}</em></span><textarea value={value} maxLength={maxLength} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>
}

function SelectControl({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return <label className="command-field"><span>{label}</span><div><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Choose…</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div></label>
}

function VectorControl({ label, value, onChange }: { label: string; value: [number, number, number]; onChange: (value: [number, number, number]) => void }) {
  return (
    <fieldset className="vector-control"><legend>{label}<em>LDU</em></legend><div>{(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis}><span>{axis}</span><input type="number" value={value[index]} onChange={(event) => { const next = [...value] as [number, number, number]; next[index] = Number(event.target.value); onChange(next) }} /></label>)}</div></fieldset>
  )
}

/**
 * Whether the kernel refuses edits that break the limit, or only reports them.
 * The wording is the whole point of the control: `hard` is not a severity label,
 * it decides whether `execute` returns CONSTRAINT_VIOLATION.
 */
function HardControl({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="constraint-enforcement">
      <ToggleControl checked={checked} onChange={onChange} label="Enforce in the kernel" />
      <small>{checked ? 'Hard — an edit that would newly break this limit is refused.' : 'Advisory — the limit is reported in validation but never blocks an edit.'}</small>
    </div>
  )
}

/** Where the model stands against the limit right now, so a refusal is legible. */
function ConstraintStatus({ current }: { current?: { label: string; status: string; message: string } }) {
  if (!current) return null
  return (
    <div className={`constraint-status ${current.status}`}>
      <span className={`check-state ${current.status}`}>{current.status === 'pass' ? <Check size={11} /> : <X size={11} />}</span>
      <div><strong>{current.label}</strong><small>Currently {current.message}</small></div>
    </div>
  )
}

function ToggleControl({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <div className="command-toggle"><button type="button" role="switch" aria-checked={checked} aria-label={label} className={checked ? 'on' : ''} onClick={() => onChange(!checked)}><i /></button><span>{label}</span></div>
}
