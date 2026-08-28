import { useState } from 'react';
import { DesignBriefV1 } from '../generation/types';

/**
 * Simple workbench allowing a user to compose a design brief and invoke the
 * generation engine via the server endpoint. It deliberately stays scoped to
 * `src/agent` so the existing app layout is untouched.
 */
export function AgentWorkbench() {
  const [brief, setBrief] = useState<Partial<DesignBriefV1>>({
    title: '',
    description: '',
  });
  const [phases, setPhases] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const updateField = (key: keyof DesignBriefV1) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setBrief({ ...brief, [key]: e.target.value });
  };

  const submit = async () => {
    setLoading(true);
    setError(null);
    setPhases([]);
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(brief),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Generation failed');
      setPhases(data.phases ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="agent-workbench">
      <h2>Design Brief Workbench</h2>
      <div className="brief-form">
        <label>
          Title
          <input type="text" value={brief.title ?? ''} onChange={updateField('title')} />
        </label>
        <label>
          Description
          <textarea value={brief.description ?? ''} onChange={updateField('description')} />
        </label>
        {/* Optional fields could be added similarly */}
        <button onClick={submit} disabled={loading}>
          {loading ? 'Generating…' : 'Generate'}
        </button>
      </div>
      {error && <p className="error">Error: {error}</p>}
      {phases.length > 0 && (
        <div className="phases">
          <h3>Generation Phases</h3>
          <ul>
            {phases.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
