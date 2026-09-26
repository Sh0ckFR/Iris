import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { invoke } from '@tauri-apps/api/core';
import { skillStore, type Skill } from '../../lib/skills';
import type { ActionRequest, OsHooks } from './osTools';

/**
 * Self-improvement: when no tool fits a request, the model can design a new *skill* (a script,
 * a web API call or a procedure over existing tools). The user sees its full definition — code
 * included — and installs it with one click; nothing is installed or run silently.
 */

const WINDOWS = navigator.userAgent.includes('Windows');
const SHELL = WINDOWS ? 'PowerShell' : 'sh';
const NAME = /^[a-z][a-z0-9_]{2,40}$/;

let seq = 0;
const nextId = () => `skill-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function paramsSchema(skill: Skill) {
  return z.object(
    Object.fromEntries(
      skill.parameters.map((p) => [p.name, p.required ? z.string().describe(p.description) : z.string().optional().describe(p.description)]),
    ),
  );
}

/** "{city}" placeholders → values (URL-encoded in URLs, JSON-escaped in bodies). */
function fill(template: string, args: Record<string, string>, encode: (v: string) => string) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => encode(args[key] ?? ''));
}
const jsonEscape = (v: string) => JSON.stringify(v).slice(1, -1);

function describeSkill(skill: Pick<Skill, 'kind' | 'script' | 'http' | 'instructions' | 'parameters'>, fr: boolean) {
  const t = (a: string, b: string) => (fr ? a : b);
  const details: ActionRequest['details'] = [];
  if (skill.parameters.length) {
    details.push({
      label: t('Paramètres', 'Parameters'),
      value: skill.parameters.map((p) => `${p.name}${p.required ? '' : '?'} — ${p.description}`).join('\n'),
    });
  }
  if (skill.kind === 'script') details.push({ label: t(`Script ${SHELL}`, `${SHELL} script`), value: skill.script ?? '', mono: true });
  if (skill.kind === 'http' && skill.http) {
    details.push({ label: 'HTTP', value: `${skill.http.method} ${skill.http.url}${skill.http.body ? `\n\n${skill.http.body}` : ''}`, mono: true });
  }
  if (skill.kind === 'procedure') details.push({ label: t('Étapes', 'Steps'), value: skill.instructions ?? '' });
  return details;
}

async function runSkill(skill: Skill, args: Record<string, string>, hooks: OsHooks, fr: boolean): Promise<unknown> {
  const t = (a: string, b: string) => (fr ? a : b);
  const ask = async (extra: ActionRequest['details'], risk: ActionRequest['risk']) => {
    if (skill.autoApprove || hooks.autonomous) return true;
    return hooks.requestApproval({
      id: nextId(),
      title: t(`Utiliser la compétence « ${skill.title} »`, `Use the skill "${skill.title}"`),
      details: [
        ...Object.entries(args).map(([k, v]) => ({ label: k, value: v })),
        ...extra,
      ],
      risk,
      onAlways: () => skillStore.update(skill.name, { autoApprove: true }),
    });
  };

  switch (skill.kind) {
    case 'procedure':
      return { followTheseSteps: skill.instructions, note: 'Carry out these steps now with your tools.' };

    case 'http': {
      const http = skill.http;
      if (!http) return { error: 'This skill has no HTTP definition.' };
      const url = fill(http.url, args, encodeURIComponent);
      const body = http.body ? fill(http.body, args, jsonEscape) : undefined;
      const headers = Object.fromEntries(Object.entries(http.headers ?? {}).map(([k, v]) => [k, fill(v, args, (x) => x)]));
      // Reading (GET) runs directly; anything that could change data asks first.
      if (http.method !== 'GET' && !(await ask([{ label: 'HTTP', value: `${http.method} ${url}`, mono: true }], 'medium'))) {
        return { done: false, note: 'The user declined.' };
      }
      hooks.onActivity(t(`Compétence « ${skill.title} »…`, `Skill "${skill.title}"…`));
      try {
        const res = await invoke<{ status: number; contentType: string; body: string }>('skill_http', { method: http.method, url, headers, body });
        return { status: res.status, contentType: res.contentType, body: res.body.slice(0, 8000) };
      } finally {
        hooks.onActivity(null);
      }
    }

    case 'script': {
      if (!(await ask([{ label: t('Script', 'Script'), value: skill.script ?? '', mono: true }], 'high'))) {
        return { done: false, note: 'The user declined.' };
      }
      hooks.onActivity(t(`Compétence « ${skill.title} »…`, `Skill "${skill.title}"…`));
      try {
        const out = await invoke<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>('run_skill_script', {
          script: skill.script ?? '',
          args,
        });
        hooks.onBriefing({ id: nextId(), kind: 'command', heading: skill.title, command: `skill_${skill.name}`, ...out });
        return { exitCode: out.exitCode, timedOut: out.timedOut, stdout: out.stdout.slice(0, 4000), stderr: out.stderr.slice(0, 1000) };
      } finally {
        hooks.onActivity(null);
      }
    }
  }
}

export function createSkillTools(hooks: OsHooks, fr: boolean, builtinNames: Set<string>): ToolSet {
  const t = (a: string, b: string) => (fr ? a : b);
  const tools: ToolSet = {};

  // Each installed skill is a tool of its own…
  for (const skill of skillStore.enabled()) {
    tools[`skill_${skill.name}`] = tool({
      description: `[Skill] ${skill.description}`,
      inputSchema: paramsSchema(skill),
      execute: (args) => runSkill(skill, args as Record<string, string>, hooks, fr),
    });
  }

  // …and run_skill reaches skills created during this very conversation.
  tools.run_skill = tool({
    description: 'Run an installed skill by name. Use it right after create_skill to use the new skill immediately.',
    inputSchema: z.object({
      name: z.string().describe('Skill name, without the "skill_" prefix'),
      args: z.record(z.string(), z.string()).optional().describe('Parameter values'),
    }),
    execute: async ({ name, args }) => {
      const skill = skillStore.get(name.replace(/^skill_/, ''));
      if (!skill || !skill.enabled) return { error: `No enabled skill named "${name}".` };
      return runSkill(skill, args ?? {}, hooks, fr);
    },
  });

  tools.create_skill = tool({
    description:
      'Create a new skill when the user asks for something none of your tools can do (never for something an existing tool already does). The user reviews the full definition and code before it is installed.',
    inputSchema: z.object({
      name: z.string().describe('snake_case identifier, e.g. "convert_currency"'),
      title: z.string().describe("Short title in the user's language"),
      description: z.string().describe('What the skill does and when to use it'),
      kind: z
        .enum(['script', 'http', 'procedure'])
        .describe(
          `"script": a ${SHELL} script run on this computer; "http": one call to a free public web API that needs no key; "procedure": steps combining your existing tools.`,
        ),
      parameters: z
        .array(z.object({ name: z.string(), description: z.string(), required: z.boolean().optional() }))
        .describe('Text inputs of the skill (may be empty)'),
      script: z
        .string()
        .optional()
        .describe(
          `For "script": the ${SHELL} script. Read each input from the environment variable ${WINDOWS ? '$env:IRIS_<NAME>' : '$IRIS_<NAME>'} (parameter name in upper case), print the result to stdout. Keep it minimal and safe; never delete data.`,
        ),
      http: z
        .object({
          method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
          url: z.string().describe('URL with {param} placeholders'),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional().describe('Body with {param} placeholders'),
        })
        .optional()
        .describe('For "http"'),
      instructions: z.string().optional().describe('For "procedure": numbered steps using your existing tools'),
      reason: z.string().describe('Why this skill is needed, in one sentence for the user'),
    }),
    execute: async (input) => {
      const name = input.name.trim().toLowerCase();
      if (!NAME.test(name)) return { error: 'Invalid name: use 3-40 lowercase letters, digits or underscores.' };
      if (builtinNames.has(name) || builtinNames.has(`skill_${name}`)) return { error: `"${name}" is a built-in tool: use it directly.` };
      if (input.kind === 'script' && !input.script?.trim()) return { error: 'A script skill needs a script.' };
      if (input.kind === 'http' && !input.http?.url) return { error: 'An http skill needs an http definition.' };
      if (input.kind === 'procedure' && !input.instructions?.trim()) return { error: 'A procedure skill needs instructions.' };
      if (input.kind === 'http' && !/^https?:\/\//.test(input.http!.url)) return { error: 'HTTP skills must use an http(s) URL.' };

      const existing = skillStore.get(name);
      const draft = {
        name,
        title: input.title.trim(),
        description: input.description.trim(),
        kind: input.kind,
        parameters: input.parameters.filter((p) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(p.name)),
        script: input.kind === 'script' ? input.script : undefined,
        http: input.kind === 'http' ? input.http : undefined,
        instructions: input.kind === 'procedure' ? input.instructions : undefined,
        reason: input.reason.trim(),
      };

      hooks.onActivity(
        hooks.autonomous
          ? t('J’installe une nouvelle compétence…', 'Installing a new skill…')
          : t('Nouvelle compétence en attente de votre accord…', 'New skill awaiting your approval…'),
      );
      let approved = !!hooks.autonomous;
      try {
        if (!approved) approved = await hooks.requestApproval({
          id: nextId(),
          title: existing
            ? t(`Mettre à jour la compétence « ${draft.title} »`, `Update the skill "${draft.title}"`)
            : t(`Nouvelle compétence : « ${draft.title} »`, `New skill: "${draft.title}"`),
          details: [
            { label: t('Pourquoi', 'Why'), value: draft.reason },
            { label: t('Ce qu’elle fait', 'What it does'), value: draft.description },
            ...describeSkill(draft, fr),
          ],
          risk: draft.kind === 'script' ? 'high' : draft.kind === 'http' ? 'medium' : 'low',
        });
      } finally {
        hooks.onActivity(null);
      }
      if (!approved) return { installed: false, note: 'The user declined this skill. Do not retry; explain what you would have needed.' };

      const saved = skillStore.save(draft);
      return {
        installed: true,
        name: saved.name,
        usage: `Installed. Call run_skill with name "${saved.name}" now to use it; from the next request it is also available as the tool skill_${saved.name}.`,
      };
    },
  });

  return tools;
}
