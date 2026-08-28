// src/features/landing/index.ts
import React, { lazy, Suspense } from "react";
import { RouteObject } from "react-router-dom";

// Lazy‑load the heavy hero component only when the route is rendered.
const LandingHero = lazy(() => import("./LandingPage"));

export const landingRoute: RouteObject = {
  path: "/",
  element: React.createElement(Suspense, { fallback: React.createElement('div', null, 'Loading…') }, React.createElement(LandingHero)),
};

export default landingRoute;
