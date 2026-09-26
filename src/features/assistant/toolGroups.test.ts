import { describe, expect, it } from 'vitest';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { definitionTokens, detectGroups, groupOf, selectTools } from './toolGroups';

const known = { skills: [], services: [] };
const groups = (text: string) => [...detectGroups(text, known)].sort();

describe('detectGroups: the tool groups a request asks for (local, no AI)', () => {
  it.each([
    ['Quelle est la météo à Lyon ?', []],
    ['Raconte-moi une blague', []],
    ['Déplace les PDF de mes téléchargements dans Documents', ['files']],
    ["Qu'est-ce que je regarde ?", ['computer']],
    ['Mets le navigateur à gauche', ['computer']],
    ['Fais-moi une page web pour mon restaurant', ['create']],
    ['mets-le en bleu', ['create']],
    ['Place les actualités du jour sur un globe par pays', ['widgets']],
    ["Zoome sur l'Europe", ['widgets']],
    ['Combien de km entre Paris et Tokyo ?', ['widgets']],
    ['Affiche mon écran du matin', ['widgets']],
    ['Épingle ça dans mon tableau de bord', ['widgets']],
    ['Cache la conversation', ['hud']],
  ])('%s → %j', (text, expected) => {
    expect(groups(text)).toEqual(expected);
  });

  it('recognises scheduling requests', () => {
    expect(groups("Rappelle-moi à 17h d'appeler Claire")).toContain('schedule');
    expect(groups('Chaque lundi à 9 h, fais-moi un résumé des marchés')).toContain('schedule');
    expect(groups('Mets un minuteur de 10 minutes')).not.toContain('schedule');
    expect(groupOf('schedule_task')).toBe('schedule');
  });

  it('recognises installed skills and connected services by name', () => {
    expect([...detectGroups('lance la météo marine', { skills: ['meteo_marine'], services: [] })]).toContain('skills');
    expect([...detectGroups('ouvre mes mails', known)]).toContain('services');
  });
});

describe('groupOf', () => {
  it('sorts the tools into groups', () => {
    expect(groupOf('get_weather')).toBe('core');
    expect(groupOf('set_alert')).toBe('core');
    expect(groupOf('run_command')).toBe('files');
    expect(groupOf('use_computer')).toBe('computer');
    expect(groupOf('show_data')).toBe('widgets');
    expect(groupOf('pin_widget')).toBe('widgets');
    expect(groupOf('skill_meteo')).toBe('skills');
    expect(groupOf('mcp_gmail_send')).toBe('services');
  });
});

describe('selectTools', () => {
  const fake = (description: string) => tool({ description, inputSchema: z.object({ q: z.string() }), execute: async () => ({}) });
  const tools: ToolSet = {
    get_weather: fake('Weather'),
    list_folder: fake('List a folder'),
    run_command: fake('Run a command'),
    create_visual: fake('Build a page'),
  };
  const guidance = (names: string[]) => names.join(',');

  it('sends only the core tools for a simple question, with load_tools for the rest', () => {
    const sel = selectTools(tools, 'Quelle heure est-il à Tokyo ?', [], guidance);
    expect(sel.active()).toEqual(['get_weather', 'load_tools']);
  });

  it('adds the groups the words call for, and the recent ones', () => {
    expect(selectTools(tools, 'Supprime ce fichier', [], guidance).active()).toContain('run_command');
    expect(selectTools(tools, 'et en rouge ?', ['create'], guidance).active()).toContain('create_visual');
  });

  it('load_tools adds a group mid-request, with its guidance', async () => {
    const sel = selectTools(tools, 'Bonjour', [], guidance);
    const result = (await sel.loadTools.load_tools.execute!({ groups: ['files'] } as never, { toolCallId: 't', messages: [] } as never)) as {
      tools: string[];
      guidance: string;
    };
    expect(result.tools).toEqual(['list_folder', 'run_command']);
    expect(result.guidance).toBe('list_folder,run_command');
    expect(sel.active()).toContain('run_command');
  });

  it('measures the definitions it does not send', () => {
    expect(definitionTokens(tools, ['get_weather'])).toBeGreaterThan(0);
    expect(definitionTokens(tools, Object.keys(tools))).toBeGreaterThan(definitionTokens(tools, ['get_weather']));
  });
});
