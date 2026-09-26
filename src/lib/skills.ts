import { useSyncExternalStore } from 'react';

/**
 * Skills: abilities Iris designs for itself when a request needs something none of its
 * built-in tools can do. Every skill is shown to the user (with its code) and installed only
 * after approval; script skills also ask before each run unless the user chose "always allow".
 */

export type SkillKind = 'script' | 'http' | 'procedure';

export interface SkillParameter {
  name: string;
  description: string;
  required?: boolean;
}

export interface Skill {
  /** Tool name exposed to the model: `skill_<name>`. */
  name: string;
  title: string;
  description: string;
  kind: SkillKind;
  parameters: SkillParameter[];
  /** kind "script": PowerShell (Windows) or sh; parameters arrive as $env:IRIS_<NAME>. */
  script?: string;
  /** kind "http": `{param}` placeholders are filled (URL-encoded in the URL). */
  http?: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; headers?: Record<string, string>; body?: string };
  /** kind "procedure": steps the model follows with its existing tools. */
  instructions?: string;
  /** Why it was created (shown in Settings). */
  reason?: string;
  enabled: boolean;
  /** Run without asking each time (the user chose "always allow"). */
  autoApprove: boolean;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_KEY = 'iris.skills.v1';
const listeners = new Set<() => void>();

function read(): Skill[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Skill[]) : [];
  } catch {
    return [];
  }
}

let skills: Skill[] = read();

function write(next: Skill[]) {
  skills = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: skills just won't survive a restart.
  }
  listeners.forEach((l) => l());
}

export const skillStore = {
  all: (): Skill[] => skills,
  enabled: (): Skill[] => skills.filter((s) => s.enabled),
  get: (name: string): Skill | undefined => skills.find((s) => s.name === name),
  /** Adds a skill or replaces the one with the same name (keeping its approval preferences). */
  save(skill: Omit<Skill, 'createdAt' | 'updatedAt' | 'enabled' | 'autoApprove'>) {
    const existing = skills.find((s) => s.name === skill.name);
    const now = Date.now();
    const next: Skill = {
      ...skill,
      enabled: true,
      autoApprove: existing?.autoApprove ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    write([...skills.filter((s) => s.name !== skill.name), next]);
    return next;
  },
  update(name: string, patch: Partial<Pick<Skill, 'enabled' | 'autoApprove'>>) {
    write(skills.map((s) => (s.name === name ? { ...s, ...patch, updatedAt: Date.now() } : s)));
  },
  remove(name: string) {
    write(skills.filter((s) => s.name !== name));
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Live list of skills for the UI. */
export function useSkills(): Skill[] {
  return useSyncExternalStore(skillStore.subscribe, skillStore.all);
}
