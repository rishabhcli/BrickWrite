// src/features/explore/ExplorePage.tsx
import React from "react";
import { useAnalytics } from "../../hooks/useAnalytics";
import { DemoItem } from "./DemoItem";

import { demoList } from "./demoData";

export const ExplorePage: React.FC = () => {
  const analytics = useAnalytics();

  const handleEdit = (demoId: string) => {
    analytics.track("demo_edit_clicked", { demoId });
    // Placeholder – will later fork the immutable demo.
    alert(`Edit demo ${demoId} (forking not implemented yet)`);
  };

  return (
    <section className="explore-page" style={{ padding: "2rem" }}>
      <h2 style={{ textAlign: "center", marginBottom: "1.5rem" }}>Explore Demos</h2>
      <div className="demo-grid" style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))" }}>
        {demoList.map((demo) => (
          <DemoItem key={demo.id} demo={demo} onEdit={handleEdit} />
        ))}
      </div>
    </section>
  );
};

export default ExplorePage;
