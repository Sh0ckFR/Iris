import { lazy, Suspense } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ErrorBoundary } from './ErrorBoundary';
import './App.css';

/**
 * The same app runs in two windows: the full HUD, and the always-on-top mini window. Each only
 * loads its own code (the mini window doesn't need Three.js, the assistant or the models).
 */
const isMini = getCurrentWindow().label === 'mini';
const Screen = isMini
  ? lazy(() => import('./features/hud/MiniHUD').then((m) => ({ default: m.MiniHUD })))
  : lazy(() => import('./features/hud/IrisHUD').then((m) => ({ default: m.IrisHUD })));

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <Screen />
      </Suspense>
    </ErrorBoundary>
  );
}
