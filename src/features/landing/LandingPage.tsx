// src/features/landing/LandingPage.tsx
import React, { useEffect, useState, lazy, Suspense } from "react";
import { useAnalytics } from "../../hooks/useAnalytics";

// Minimal interactive hero – a rotating brick placeholder that reacts to a short text input.
// Real generation pipeline is deferred to a later load to keep LCP low.
const BrickScene = lazy(() => import("./BrickScene"));

export const LandingHero: React.FC = () => {
  const [prompt, setPrompt] = useState("");
  const [showDemo, setShowDemo] = useState(false);
  const [stage, setStage] = useState<'brief' | 'candidate' | 'refinement' | 'validated'>('brief');
  const analytics = useAnalytics();

  // Simple CSS animation trigger – rotates a brick when a prompt is submitted.
  useEffect(() => {
    if (showDemo) {
      analytics.track("hero_prompt_submitted", { prompt });
    }
  }, [showDemo, prompt, analytics]);

  // Simulate generation pipeline stages after demo is shown.
  useEffect(() => {
    if (!showDemo) return;
    const stages: Array<{ name: typeof stage; label: string }> = [
      { name: 'brief', label: 'Generating brief…' },
      { name: 'candidate', label: 'Creating candidate model…' },
      { name: 'refinement', label: 'Refining model…' },
      { name: 'validated', label: 'Validating model…' },
    ];
    let index = 0;
    const interval = setInterval(() => {
      const next = stages[index + 1];
      if (!next) {
        clearInterval(interval);
        return;
      }
      setStage(next.name);
      analytics.track("hero_demo_stage", { stage: next.name, prompt });
      index++;
    }, 2000);
    // Cleanup on unmount or when demo hidden
    return () => clearInterval(interval);
  }, [showDemo, analytics, prompt]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim()) setShowDemo(true);
  };

  return (
    <section className="landing-hero" style={{ textAlign: "center", padding: "4rem 1rem" }}>
      <h1 style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>Brickwright</h1>
      <p style={{ fontSize: "1.125rem", marginBottom: "2rem" }}>
        Turn natural‑language ideas into 3‑D brick models – instantly.
      </p>
      <form onSubmit={handleSubmit} style={{ marginBottom: "2rem" }}>
        <input
          type="text"
          placeholder="e.g. a small wooden bridge"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={{ padding: "0.5rem 1rem", width: "80%", maxWidth: "400px" }}
          aria-label="Prompt for brick model"
        />
        <button type="submit" style={{ marginLeft: "0.5rem", padding: "0.5rem 1rem" }}>
          Build
        </button>
      </form>
      {showDemo && (
        <React.Suspense fallback={<div>Loading demo…</div>}>
          <BrickScene />
          </React.Suspense>
        )}
        {/* Display current generation stage */}
        {showDemo && (
          <p style={{ marginTop: '1rem', fontStyle: 'italic' }}>
            {stage === 'brief' && 'Generating brief…'}
            {stage === 'candidate' && 'Creating candidate model…'}
            {stage === 'refinement' && 'Refining model…'}
            {stage === 'validated' && 'Model validated!'}
          </p>
        )}
        <style jsx>{`

        @keyframes spin {
          from { transform: rotateY(0deg); }
          to { transform: rotateY(360deg); }
        }
        .brick {
          width: 120px;
          height: 120px;
          background: linear-gradient(45deg, #d4a76a, #c1893e);
          border: 4px solid #8b5e3c;
          animation: spin 3s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .brick { animation: none; }
        }
      `}</style>
    </section>
  );
};

export default LandingHero;
