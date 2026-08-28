// src/features/landing/BrickScene.tsx
/**
 * Very lightweight three‑js scene that pretends to assemble a brick model.
 * It is deliberately simple – a single rotating cube – to keep bundle size
 * tiny while still exercising a real WebGL canvas. In a full implementation
 * this would be replaced by the actual generation pipeline.
 */
import React, { useRef, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";

// Cube that spins and changes color to simulate refinement stages.
const SpinningBrick: React.FC = () => {
  const mesh = useRef<THREE.Mesh>(null!);
  const [stage, setStage] = React.useState(0);

  // Advance stage every 2 seconds – 0: rough, 1: refined, 2: validated.
  useEffect(() => {
    const timer = setInterval(() => setStage((s) => (s + 1) % 3), 2000);
    return () => clearInterval(timer);
  }, []);

  useFrame(() => {
    if (mesh.current) {
      mesh.current.rotation.y += 0.01;
    }
  });

  const colors = ["#d4a76a", "#c1893e", "#8b5e3c"];
  const materialColor = colors[stage];

  return (
    <mesh ref={mesh} position={[0, 0, 0]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={materialColor} />
    </mesh>
  );
};

export const BrickScene: React.FC = () => {
  return (
    <Canvas style={{ width: "100%", height: "300px" }} camera={{ position: [2, 2, 5] }}>
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 5, 5]} intensity={0.7} />
      <SpinningBrick />
      <OrbitControls enableZoom={false} enablePan={false} />
    </Canvas>
  );
};

export default BrickScene;
