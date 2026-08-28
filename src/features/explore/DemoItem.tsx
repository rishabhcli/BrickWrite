// src/features/explore/DemoItem.tsx
import React from "react";
import { Link } from "react-router-dom";

export interface Demo {
  id: string;
  title: string;
  category: string;
}

interface Props {
  demo: Demo;
  onEdit: (demoId: string) => void;
}

export const DemoItem: React.FC<Props> = ({ demo, onEdit }) => {
  return (
    <article className="demo-item" style={{ border: "1px solid #ddd", borderRadius: "8px", overflow: "hidden", background: "#fafafa" }}>
      <div className="thumb" style={{ height: "150px", background: "#e0e0e0" }} aria-label={`Thumbnail for ${demo.title}`} />
      <div style={{ padding: "0.75rem" }}>
        <h3 style={{ margin: "0 0 0.5rem" }}>{demo.title}</h3>
        <p style={{ margin: "0 0 0.75rem", color: "#666", fontSize: "0.875rem" }}>{demo.category}</p>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <Link to={`/explore/${demo.id}`} style={{ textDecoration: "none", color: "#0066cc" }}>
            View
          </Link>
          <button onClick={() => onEdit(demo.id)} style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer" }}>
            Edit this build
          </button>
        </div>
      </div>
    </article>
  );
};
