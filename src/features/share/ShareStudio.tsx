// Share Studio placeholder component
import React from "react";

export const ShareStudio: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  return (
    <div style={{position: "relative", padding: "1rem", background: "white", borderRadius: "8px"}}>
      {/* TODO: Implement camera, lighting, background, crop, framing, watermark, export options */}
        {onClose && (<button onClick={onClose} style={{position: "absolute", top: 8, right: 8}}>Close</button>)}
      <p>Share Studio UI coming soon.</p>
    </div>
  );
};
