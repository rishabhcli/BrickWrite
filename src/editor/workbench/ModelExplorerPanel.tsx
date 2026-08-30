import {
  Bot,
  Box,
  Crosshair,
  Eye,
  EyeOff,
  Lock,
  Search,
  Shield,
  Unlock,
  UserRound,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { catalog, getColor } from '../../cad/catalog'
import { cadEngine } from '../../cad/engine'
import type { PartInstance, Subassembly } from '../../cad/types'
import type { Workbench } from './useWorkbench'

type ExplorerMode = 'tree' | 'selected' | 'agent'

const FIRST_PAGE = 64
const PAGE_SIZE = 64

interface ExplorerPart {
  part: PartInstance
  name: string
  category: string
  assemblyName: string
  search: string
}

/**
 * A scalable map of the placed model, rather than another catalogue.
 *
 * The library answers “what can I place?”; this panel answers “what is already
 * here?”. It renders assemblies first and pages flat part searches, so an
 * 11,000-part document never creates 11,000 DOM rows. Selection, framing,
 * isolation and assembly locks all use the same workbench/kernel paths as the
 * viewport and WebMCP.
 */
export function ModelExplorerPanel({ workbench }: { workbench: Workbench }) {
  const { state } = workbench
  const [mode, setMode] = useState<ExplorerMode>('tree')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(FIRST_PAGE)

  const assemblies = useMemo(
    () => Object.values(state.document.subassemblies).sort((a, b) => a.name.localeCompare(b.name)),
    [state.document.subassemblies],
  )
  const assemblyById = useMemo(
    () => new Map(assemblies.map((assembly) => [assembly.id, assembly])),
    [assemblies],
  )
  const parts = useMemo<ExplorerPart[]>(
    () =>
      Object.values(state.document.parts).map((part) => {
        const definition = catalog.get(part.definitionId)
        const assemblyName = assemblyById.get(part.subassemblyId)?.name ?? part.subassemblyId
        const name = definition?.name ?? part.definitionId
        const category = definition?.category ?? 'Uncatalogued'
        return {
          part,
          name,
          category,
          assemblyName,
          search: `${part.id} ${part.definitionId} ${name} ${category} ${part.subassemblyId} ${assemblyName}`.toLowerCase(),
        }
      }),
    [assemblyById, state.document.parts],
  )

  const selected = useMemo(() => new Set(state.selection), [state.selection])
  const normalised = query.trim().toLowerCase()
  const assemblyQuery = normalised.startsWith('@') ? normalised.slice(1) : null
  const filteredParts = useMemo(() => {
    let candidates = parts
    if (mode === 'selected') candidates = candidates.filter(({ part }) => selected.has(part.id))
    else if (mode === 'agent') candidates = candidates.filter(({ part }) => part.provenance === 'agent')

    if (assemblyQuery !== null) {
      return candidates.filter(({ part }) => part.subassemblyId.toLowerCase() === assemblyQuery)
    }
    if (normalised) return candidates.filter((entry) => entry.search.includes(normalised))
    return mode === 'tree' ? [] : candidates
  }, [assemblyQuery, mode, normalised, parts, selected])

  const matchingAssemblies = useMemo(() => {
    if (mode !== 'tree' || normalised) return []
    return assemblies
  }, [assemblies, mode, normalised])

  useEffect(() => setLimit(FIRST_PAGE), [mode, query])

  const selectParts = (partIds: readonly string[], action: 'select' | 'frame' | 'isolate' = 'select') => {
    cadEngine.setSelection([...partIds])
    if (action === 'frame') workbench.focusSelection()
    if (action === 'isolate') workbench.isolateSelection()
  }

  const browseAssembly = (assembly: Subassembly) => {
    setMode('tree')
    setQuery(`@${assembly.id}`)
  }

  const visibleParts = filteredParts.slice(0, limit)
  const { humanCount, agentCount, protectedCount } = useMemo(
    () =>
      parts.reduce(
        (counts, { part }) => {
          if (part.provenance === 'agent') counts.agentCount += 1
          else counts.humanCount += 1
          if (part.protected) counts.protectedCount += 1
          return counts
        },
        { humanCount: 0, agentCount: 0, protectedCount: 0 },
      ),
    [parts],
  )
  const resultDescription = normalised
    ? `${filteredParts.length} matching placed part${filteredParts.length === 1 ? '' : 's'}`
    : mode === 'selected'
      ? `${filteredParts.length} selected part${filteredParts.length === 1 ? '' : 's'}`
      : mode === 'agent'
        ? `${filteredParts.length} agent-authored part${filteredParts.length === 1 ? '' : 's'}`
        : `${assemblies.length} assemblies`

  return (
    <aside className="model-map" aria-label="Model map">
      <header className="model-map-hero">
        <div>
          <span className="eyebrow">PLACED MODEL</span>
          <strong>{String(parts.length).padStart(3, '0')}</strong>
          <small>parts across {assemblies.length} assemblies</small>
        </div>
        <div className="model-map-authorship" aria-label="Part authorship">
          <span><UserRound size={10} /> {humanCount}</span>
          <span><Bot size={10} /> {agentCount}</span>
          <span><Shield size={10} /> {protectedCount}</span>
        </div>
      </header>

      <div className="model-map-search">
        <Search size={12} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search placed name, ID, or @assembly"
          aria-label="Search placed model"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label="Clear model search">
            <X size={11} />
          </button>
        )}
      </div>

      <div className="model-map-tabs" role="tablist" aria-label="Model map scope">
        <button role="tab" aria-selected={mode === 'tree'} className={mode === 'tree' ? 'active' : ''} onClick={() => setMode('tree')}>
          ASSEMBLIES <em>{assemblies.length}</em>
        </button>
        <button role="tab" aria-selected={mode === 'selected'} className={mode === 'selected' ? 'active' : ''} onClick={() => setMode('selected')}>
          SELECTED <em>{state.selection.length}</em>
        </button>
        <button role="tab" aria-selected={mode === 'agent'} className={mode === 'agent' ? 'active' : ''} onClick={() => setMode('agent')}>
          AGENT <em>{agentCount}</em>
        </button>
      </div>

      <div className="model-map-scopebar">
        <span>{resultDescription}</span>
        {state.selection.length > 0 && (
          <div>
            <button type="button" title="Frame selection" aria-label="Frame model-map selection" onClick={workbench.focusSelection}>
              <Crosshair size={11} />
            </button>
            <button type="button" title="Isolate selection" aria-label="Isolate model-map selection" onClick={workbench.isolateSelection}>
              <Eye size={11} />
            </button>
            <button type="button" title="Clear selection" aria-label="Clear model-map selection" onClick={() => cadEngine.setSelection([])}>
              <X size={11} />
            </button>
          </div>
        )}
      </div>

      <div className="model-map-results">
        {matchingAssemblies.map((assembly) => {
          const assemblySelected = assembly.partIds.length > 0 && assembly.partIds.every((id) => selected.has(id))
          return (
            <article
              className={`model-assembly-row ${assemblySelected ? 'selected' : ''}`}
              key={assembly.id}
              style={{ '--assembly-accent': assembly.accent } as React.CSSProperties}
            >
              <button
                type="button"
                className="model-assembly-main"
                onClick={() => selectParts(assembly.partIds)}
                title={`Select all ${assembly.partIds.length} parts in ${assembly.name}`}
              >
                <span className="model-assembly-mark"><Box size={13} /></span>
                <span>
                  <strong>{assembly.name}</strong>
                  <small>{assembly.id} · {assembly.partIds.length} parts</small>
                </span>
                {assembly.locked ? <Lock size={11} /> : <Unlock size={11} />}
              </button>
              <footer>
                <button type="button" onClick={() => selectParts(assembly.partIds, 'frame')}><Crosshair size={10} /> FRAME</button>
                <button type="button" onClick={() => selectParts(assembly.partIds, 'isolate')}><EyeOff size={10} /> ISOLATE</button>
                <button type="button" onClick={() => browseAssembly(assembly)}>BROWSE</button>
                <button
                  type="button"
                  className={assembly.locked ? 'locked' : ''}
                  onClick={() => workbench.runSharedMutation('lock_subassembly', {
                    subassemblyId: assembly.id,
                    locked: !assembly.locked,
                  })}
                >
                  {assembly.locked ? 'UNLOCK' : 'LOCK'}
                </button>
              </footer>
            </article>
          )
        })}

        {visibleParts.map((entry) => (
          <PartRow
            key={entry.part.id}
            entry={entry}
            selected={selected.has(entry.part.id)}
            onSelect={(additive) => {
              if (!additive) return selectParts([entry.part.id])
              const next = new Set(state.selection)
              if (next.has(entry.part.id)) next.delete(entry.part.id)
              else next.add(entry.part.id)
              selectParts([...next])
            }}
            onFrame={() => selectParts([entry.part.id], 'frame')}
          />
        ))}

        {!matchingAssemblies.length && !visibleParts.length && (
          <div className="model-map-empty">
            <Search size={18} />
            <strong>{mode === 'selected' && !normalised ? 'Nothing is selected.' : 'No placed part matches.'}</strong>
            <span>{mode === 'selected' && !normalised ? 'Pick a part in the viewport or open an assembly.' : 'Try a mould ID, instance ID, colour, or assembly name.'}</span>
          </div>
        )}

        {visibleParts.length < filteredParts.length && (
          <button className="model-map-more" type="button" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
            SHOW {Math.min(PAGE_SIZE, filteredParts.length - visibleParts.length)} MORE
            <small>{visibleParts.length} / {filteredParts.length}</small>
          </button>
        )}
      </div>
    </aside>
  )
}

function PartRow({
  entry,
  selected,
  onSelect,
  onFrame,
}: {
  entry: ExplorerPart
  selected: boolean
  onSelect: (additive: boolean) => void
  onFrame: () => void
}) {
  const color = getColor(entry.part.color)
  return (
    <article className={`model-part-row ${selected ? 'selected' : ''}`}>
      <button
        type="button"
        className="model-part-main"
        aria-pressed={selected}
        title="Select this placed part; Shift-click to add or remove it from the selection"
        onClick={(event) => onSelect(event.shiftKey)}
      >
        <i style={{ '--part-color': color.hex } as React.CSSProperties} />
        <span>
          <strong>{entry.name}</strong>
          <small>{entry.part.id} · {entry.part.definitionId}</small>
        </span>
        <em className={entry.part.provenance}>{entry.part.provenance === 'agent' ? <Bot size={10} /> : <UserRound size={10} />}</em>
        {entry.part.protected && <Lock className="model-part-lock" size={10} />}
      </button>
      <footer>
        <span>{entry.assemblyName}</span>
        <span>{entry.category}</span>
        <button type="button" aria-label={`Frame ${entry.part.id}`} onClick={onFrame}><Crosshair size={10} /></button>
      </footer>
    </article>
  )
}
