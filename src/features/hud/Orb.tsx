import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sparkles } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { Phase } from '../assistant/useAssistant';

/**
 * Iris's eye, at the centre of the HUD: an iris drawn as a camera aperture (six blades around a
 * hexagonal pupil) over glowing radial fibres, a ring of audio bars driven by the voice level,
 * and graduated rings, with bloom for the glow. The pupil opens when listening, closes and spins
 * when thinking, pulses with the voice, and the eye glances toward the pointer.
 * Colours are pushed above 1.0 (toneMapped off) so only these elements bloom.
 */

const PHASE_COLOR: Record<Phase, string> = {
  idle: '#76b900',
  listening: '#a6ff2e',
  thinking: '#d9ff7a',
  speaking: '#8fdc00',
};
/** Pupil size (apothem of the hexagon) per phase. */
const PHASE_PUPIL: Record<Phase, number> = { idle: 0.2, listening: 0.27, thinking: 0.15, speaking: 0.2 };
const HIGHLIGHT = '#d9ff7a';
const GREEN = '#76b900';

const IRIS = 0.6;
const BLADES = 6;
const FIBERS = 160;
const BAR_COUNT = 72;
const TICK_COUNT = 96;

interface OrbProps {
  phase: Phase;
  /** 0..1 loudness of the mic (listening) or the voice (speaking), read every frame. */
  levelRef: RefObject<number>;
  /** Click on the eye (none: it is purely a display). */
  onActivate?: () => void;
}

/** A flat ring arc in the XY plane. */
function Arc({
  inner,
  outer,
  start = 0,
  length = Math.PI * 2,
  color,
  opacity = 1,
  intensity = 1.6,
  segments = 128,
}: {
  inner: number;
  outer: number;
  start?: number;
  length?: number;
  color: string;
  opacity?: number;
  intensity?: number;
  segments?: number;
}) {
  const c = useMemo(() => new THREE.Color(color).multiplyScalar(intensity), [color, intensity]);
  return (
    <mesh>
      <ringGeometry args={[inner, outer, segments, 1, start, length]} />
      <meshBasicMaterial color={c} transparent opacity={opacity} toneMapped={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

/** Evenly spaced instanced boxes around a circle (ticks). */
function useRadial(ref: RefObject<THREE.InstancedMesh | null>, count: number, radius: number, size: (i: number) => [number, number]) {
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const [w, h] = size(i);
      m.position.set(Math.cos(a) * radius, Math.sin(a) * radius, 0);
      m.rotation.set(0, 0, a - Math.PI / 2);
      m.scale.set(w, h, 1);
      m.updateMatrix();
      mesh.setMatrixAt(i, m.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, [ref, count, radius, size]);
}

/** Deterministic 0..1 noise: the fibres keep their look from frame to frame. */
const noise = (i: number, k: number) => {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const FIBER_SHAPE = Array.from({ length: FIBERS }, (_, i) => ({
  angle: (i / FIBERS) * Math.PI * 2 + (noise(i, 1) - 0.5) * 0.03,
  reach: IRIS * (0.72 + 0.26 * noise(i, 2)),
  width: 0.004 + noise(i, 3) * 0.006,
  shine: 0.35 + 0.65 * noise(i, 4),
}));

function Eye({ phase, levelRef, onActivate }: OrbProps) {
  const group = useRef<THREE.Group>(null);
  const eye = useRef<THREE.Group>(null);
  const fibers = useRef<THREE.InstancedMesh>(null);
  const blades = useRef<THREE.InstancedMesh>(null);
  const bladeMat = useRef<THREE.MeshBasicMaterial>(null);
  const pupil = useRef<THREE.Mesh>(null);
  const pupilRim = useRef<THREE.Mesh>(null);
  const rimMat = useRef<THREE.MeshBasicMaterial>(null);
  const irisMat = useRef<THREE.MeshBasicMaterial>(null);
  const limbusMat = useRef<THREE.MeshBasicMaterial>(null);
  const bars = useRef<THREE.InstancedMesh>(null);
  const barMat = useRef<THREE.MeshBasicMaterial>(null);
  const ticks = useRef<THREE.InstancedMesh>(null);
  const ringA = useRef<THREE.Group>(null);
  const ringB = useRef<THREE.Group>(null);
  const ringC = useRef<THREE.Group>(null);
  const smoothed = useRef(0);
  const apothem = useRef(PHASE_PUPIL.idle);
  const spin = useRef(0);
  const color = useMemo(() => new THREE.Color(PHASE_COLOR.idle), []);
  const target = useMemo(() => new THREE.Color(), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useRadial(ticks, TICK_COUNT, 1.16, (i) => (i % 8 === 0 ? [0.012, 0.09] : [0.008, 0.04]));

  // Fibres: brighter or dimmer strands (instance colours multiply the material's).
  useLayoutEffect(() => {
    const mesh = fibers.current;
    if (!mesh) return;
    const c = new THREE.Color();
    FIBER_SHAPE.forEach((f, i) => mesh.setColorAt(i, c.setScalar(f.shine)));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, []);

  useFrame(({ clock, pointer }, delta) => {
    const t = clock.elapsedTime;
    const level = levelRef.current ?? 0;
    // Fast attack, slow release: pops on syllables, settles smoothly.
    smoothed.current += (level - smoothed.current) * (level > smoothed.current ? 0.4 : 0.08);
    const s = smoothed.current;
    const busy = phase === 'thinking';

    target.set(PHASE_COLOR[phase]);
    color.lerp(target, 0.06);
    const glow = 1.6 + s * 2.2 + (phase === 'idle' ? Math.sin(t * 1.6) * 0.2 : 0);
    rimMat.current?.color.copy(color).multiplyScalar(glow + 0.6);
    bladeMat.current?.color.copy(color).multiplyScalar(glow);
    irisMat.current?.color.copy(color).multiplyScalar(0.35 + s * 0.3);
    limbusMat.current?.color.copy(color).multiplyScalar(2 + s);
    barMat.current?.color.copy(color).multiplyScalar(1.8);

    // The pupil: its size follows the phase and the voice; it breathes when idle.
    const wanted =
      PHASE_PUPIL[phase] +
      s * 0.12 +
      (phase === 'idle' ? Math.sin(t * 1.2) * 0.012 : 0) +
      (busy ? Math.sin(t * 5) * 0.02 : 0);
    apothem.current += (wanted - apothem.current) * 0.12;
    const a = apothem.current;
    spin.current += delta * (busy ? 2.4 : 0.12 + s * 0.8);
    const φ = spin.current;

    // Hexagon: circumradius = apothem / cos(30°); its sides lie on the blades' edges.
    const circum = a / Math.cos(Math.PI / BLADES);
    pupil.current?.scale.setScalar(circum);
    pupil.current?.rotation.set(0, 0, φ - Math.PI / BLADES);
    pupilRim.current?.scale.setScalar(circum);
    pupilRim.current?.rotation.set(0, 0, φ - Math.PI / BLADES);

    // Blade edges: each tangent to the pupil, from its corner out to the iris edge.
    const bladeMesh = blades.current;
    if (bladeMesh) {
      const half = a * Math.tan(Math.PI / BLADES);
      const reach = Math.sqrt(IRIS * IRIS - a * a);
      for (let i = 0; i < BLADES; i++) {
        const θ = φ + (i / BLADES) * Math.PI * 2;
        const mid = (half + reach) / 2;
        dummy.position.set(a * Math.cos(θ) - mid * Math.sin(θ), a * Math.sin(θ) + mid * Math.cos(θ), 0.002);
        dummy.rotation.set(0, 0, θ);
        dummy.scale.set(0.007, reach - half, 1);
        dummy.updateMatrix();
        bladeMesh.setMatrixAt(i, dummy.matrix);
      }
      bladeMesh.instanceMatrix.needsUpdate = true;
    }

    // Fibres start at the pupil's edge and shimmer slowly.
    const fiberMesh = fibers.current;
    if (fiberMesh) {
      const from = circum + 0.012;
      FIBER_SHAPE.forEach((f, i) => {
        const angle = f.angle - t * 0.02;
        const to = Math.max(from + 0.02, f.reach * (1 + 0.02 * Math.sin(t * 2 + i)));
        const r = (from + to) / 2;
        dummy.position.set(Math.cos(angle) * r, Math.sin(angle) * r, 0);
        dummy.rotation.set(0, 0, angle - Math.PI / 2);
        dummy.scale.set(f.width, to - from, 1);
        dummy.updateMatrix();
        fiberMesh.setMatrixAt(i, dummy.matrix);
      });
      fiberMesh.instanceMatrix.needsUpdate = true;
    }

    if (ringA.current) ringA.current.rotation.z += delta * (busy ? 1.2 : 0.18);
    if (ringB.current) ringB.current.rotation.z -= delta * (busy ? 0.7 : 0.06);
    if (ringC.current) ringC.current.rotation.z += delta * (busy ? 2.2 : 0.45);

    // Audio bars: length follows the voice, with per-bar variation so it reads as a waveform.
    const mesh = bars.current;
    if (mesh) {
      for (let i = 0; i < BAR_COUNT; i++) {
        const angle = (i / BAR_COUNT) * Math.PI * 2;
        const wobble = 0.5 + 0.5 * Math.sin(i * 1.7 + t * 9) * Math.sin(i * 0.37 - t * 5);
        const idle = busy ? 0.35 + 0.35 * Math.sin(i * 0.5 - t * 6) : 0.12;
        const len = 0.015 + 0.24 * Math.max(idle * 0.3, s * (0.35 + 0.65 * wobble));
        const r = 0.7 + len / 2;
        dummy.position.set(Math.cos(angle) * r, Math.sin(angle) * r, 0);
        dummy.rotation.set(0, 0, angle - Math.PI / 2);
        dummy.scale.set(0.014, len, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    // The eye glances toward the pointer; the whole HUD tilts slightly with it.
    if (eye.current) {
      eye.current.position.x = THREE.MathUtils.lerp(eye.current.position.x, pointer.x * 0.06, 0.06);
      eye.current.position.y = THREE.MathUtils.lerp(eye.current.position.y, pointer.y * 0.05, 0.06);
    }
    if (group.current) {
      group.current.rotation.x = THREE.MathUtils.lerp(group.current.rotation.x, -pointer.y * 0.25, 0.05);
      group.current.rotation.y = THREE.MathUtils.lerp(group.current.rotation.y, pointer.x * 0.35, 0.05);
    }
  });

  return (
    <group
      ref={group}
      {...(onActivate && {
        onClick: (e: { stopPropagation: () => void }) => {
          e.stopPropagation();
          onActivate();
        },
        onPointerOver: () => (document.body.style.cursor = 'pointer'),
        onPointerOut: () => (document.body.style.cursor = ''),
      })}
    >
      <group ref={eye}>
        {/* Iris body and its fibres */}
        <mesh position={[0, 0, -0.01]}>
          <circleGeometry args={[IRIS, 96]} />
          <meshBasicMaterial ref={irisMat} transparent opacity={0.28} toneMapped={false} />
        </mesh>
        <instancedMesh ref={fibers} args={[undefined, undefined, FIBERS]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial color={new THREE.Color(HIGHLIGHT).multiplyScalar(1.1)} transparent opacity={0.75} toneMapped={false} />
        </instancedMesh>

        {/* Aperture: blade edges, black hexagonal pupil and its glowing rim */}
        <instancedMesh ref={blades} args={[undefined, undefined, BLADES]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial ref={bladeMat} transparent opacity={0.95} toneMapped={false} />
        </instancedMesh>
        <mesh ref={pupil} position={[0, 0, 0.004]}>
          <circleGeometry args={[1, BLADES]} />
          <meshBasicMaterial color="#000000" toneMapped={false} />
        </mesh>
        <mesh ref={pupilRim} position={[0, 0, 0.005]}>
          <ringGeometry args={[0.93, 1.02, BLADES, 1]} />
          <meshBasicMaterial ref={rimMat} toneMapped={false} />
        </mesh>
        {/* Catchlight: what makes it read as an eye */}
        <mesh position={[-0.075, 0.085, 0.006]}>
          <circleGeometry args={[0.035, 32]} />
          <meshBasicMaterial color={new THREE.Color('#f1ffe0').multiplyScalar(2.2)} toneMapped={false} />
        </mesh>
        <mesh position={[0.06, -0.06, 0.006]}>
          <circleGeometry args={[0.013, 24]} />
          <meshBasicMaterial color={new THREE.Color('#f1ffe0').multiplyScalar(1.4)} transparent opacity={0.7} toneMapped={false} />
        </mesh>

        {/* Limbus: the iris's glowing edge */}
        <mesh>
          <ringGeometry args={[IRIS, IRIS + 0.018, 128]} />
          <meshBasicMaterial ref={limbusMat} transparent opacity={0.95} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
      </group>

      {/* Voice bars */}
      <instancedMesh ref={bars} args={[undefined, undefined, BAR_COUNT]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial ref={barMat} transparent opacity={0.9} toneMapped={false} />
      </instancedMesh>

      <Arc inner={0.99} outer={1.0} color={GREEN} opacity={0.6} />

      {/* Segmented ring */}
      <group ref={ringA}>
        {[0, 1, 2].map((i) => (
          <Arc key={i} inner={1.03} outer={1.07} start={(i * Math.PI * 2) / 3} length={Math.PI * 0.52} color={GREEN} opacity={0.8} />
        ))}
      </group>

      {/* Graduations */}
      <group ref={ringB}>
        <instancedMesh ref={ticks} args={[undefined, undefined, TICK_COUNT]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial color={new THREE.Color(GREEN).multiplyScalar(1.3)} transparent opacity={0.7} toneMapped={false} />
        </instancedMesh>
      </group>

      {/* Bright accent arcs */}
      <group ref={ringC}>
        <Arc inner={1.3} outer={1.345} start={0.3} length={0.9} color={HIGHLIGHT} opacity={0.85} intensity={1.5} />
        <Arc inner={1.3} outer={1.345} start={Math.PI + 0.3} length={0.9} color={HIGHLIGHT} opacity={0.85} intensity={1.5} />
        <Arc inner={1.37} outer={1.38} start={2.1} length={0.6} color={HIGHLIGHT} opacity={0.5} />
        {/* Hexagonal frame echoing the pupil */}
        <Arc inner={1.44} outer={1.447} color={GREEN} opacity={0.35} segments={6} />
      </group>

      {/* Outer dashed ring */}
      {Array.from({ length: 48 }, (_, i) => (
        <Arc key={i} inner={1.56} outer={1.57} start={(i / 48) * Math.PI * 2} length={0.07} color={GREEN} opacity={0.45} />
      ))}

      <Sparkles count={40} scale={[4, 4, 1]} size={1.6} speed={0.25} color="#b6ff4d" opacity={0.5} />
    </group>
  );
}

/** Iris's eye: its colour, pupil and audio bars follow what Iris is doing. */
export function Orb(props: OrbProps) {
  return (
    <Canvas
      className="hud-orb-canvas"
      camera={{ position: [0, 0, 4.6], fov: 45 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
    >
      <Eye {...props} />
      <EffectComposer>
        <Bloom mipmapBlur intensity={1.1} luminanceThreshold={0.9} luminanceSmoothing={0.2} radius={0.7} />
      </EffectComposer>
    </Canvas>
  );
}
