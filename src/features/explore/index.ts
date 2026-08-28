// src/features/explore/index.ts
import React, { lazy, Suspense } from "react";
import { RouteObject } from "react-router-dom";

const ExplorePage = lazy(() => import("./ExplorePage"));

export const exploreRoute: RouteObject = {
  path: "/explore",
  element: React.createElement(Suspense, { fallback: React.createElement('div', null, 'Loading…') }, React.createElement(ExplorePage)),
};

export default exploreRoute;
