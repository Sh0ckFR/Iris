import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

/**
 * Dynamic tool selection. Every tool definition is sent with every step of every request, and
 * they had become most of the prompt (~26,000 input tokens for a 3-step answer). So only a core
 * set goes every time, and the other groups join when the request needs them:
 *  1. a local intent check on the user's words (no AI, instant) picks the likely groups;
 *  2. groups used in the last exchanges stay for follow-ups ("mets-le en bleu", "et le Japon ?");
 *  3. load_tools lets the model add a group itself when the guess missed one (one extra step).
 */

export type ToolGroup = 'files' | 'computer' | 'create' | 'widgets' | 'hud' | 'schedule' | 'personal' | 'skills' | 'services';

const GROUPS: ToolGroup[] = ['files', 'computer', 'create', 'widgets', 'hud', 'schedule', 'personal', 'skills', 'services'];

/** What each group is for, in load_tools' description. */
const GROUP_INFO: Record<ToolGroup, string> = {
  files: 'files and folders (list, create, write, move, rename, delete) and shell commands',
  computer: 'application windows (focus, move, close), the mouse and keyboard in other apps, and looking at the screen',
  create: 'creating web pages, apps, games, documents, diagrams, code, logos (create_visual) and images',
  widgets: 'showing data in widgets: map / globe, chart, table, key figures, timeline, cards, live quotes and weather',
  hud: 'moving, resizing, showing or hiding the HUD panels and the Iris windows',
  schedule: 'reminders at a given time and tasks run later or regularly (every morning, each Monday…), and cancelling them',
  personal: "the user's own calendar and e-mail inbox (read only)",
  skills: 'self-written skills: create one for something no tool can do, or run an installed one',
  services: 'the connected external services (MCP: mail, calendar, home, GitHub…)',
};

export function groupOf(name: string): ToolGroup | 'core' {
  if (/^(list_folder|create_folder|write_text_file|move_or_rename|delete_to_trash|open_file_or_folder|run_command)$/.test(name)) return 'files';
  if (/^(list_windows|manage_window|use_computer|look_at_screen)$/.test(name)) return 'computer';
  if (/^(create_visual|generate_image)$/.test(name)) return 'create';
  if (/^(show_data|pin_widget|show_dashboard)$/.test(name)) return 'widgets';
  if (/^(arrange_panels|control_window)$/.test(name)) return 'hud';
  if (/^(schedule_task|cancel_schedule)$/.test(name)) return 'schedule';
  if (/^(check_calendar|check_email|read_email)$/.test(name)) return 'personal';
  if (/^(create_skill|run_skill|skill_)/.test(name)) return 'skills';
  if (name.startsWith('mcp_')) return 'services';
  // Live information, opening apps and sites, volume, timers, memory, documents, stop listening.
  return 'core';
}

const normalize = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ').replace(/\s+/g, ' ');

/** Words that announce each group (French and English, accents removed). Generous on purpose: a false positive only costs a few tokens, a miss costs a load_tools step. */
const INTENTS: Record<Exclude<ToolGroup, 'services' | 'skills'>, RegExp> = {
  files:
    /\b(fichiers?|dossiers?|repertoires?|telechargements?|downloads?|folders?|files?|desktop|bureau|documents? (de|du|dans)|mes documents|copie|copier|deplace les|deplacer|renomm|rename|supprim|efface|delete|corbeille|trash|recycle|enregistre (le|la|ca|dans)|sauvegarde|ecris (dans|un fichier|le fichier)|cree un (dossier|fichier)|commande|powershell|cmd|terminal|shell|installe|desinstalle|disque|espace libre|chemin|[a-z]:\\|zip|dezippe|extrais)\b|\.(pdf|txt|docx?|xlsx?|csv|png|jpe?g|zip|exe|mp3|mp4|json)\b/,
  computer:
    /\b(fenetres?|windows?|ecran(?! du | de )|screen|clique|click|appuie sur|tape |type |coche|decoche|menu|bouton|button|onglet|tab|regarde|look at|vois|voir|je regarde|what am i|cette (erreur|page|image|fenetre|case)|this (error|page|window)|maximi[sz]|minimi[sz]|agrandi|reduis|ferme (le|la|l |les|mon|ma|mes|cette|ce|cet)|close|autre ecran|other screen|second ecran|remplis|formulaire|form|selectionne|select|scroll|defile|glisse|drag|a gauche|a droite|left half|right half|en plein ecran|full screen)\b/,
  create:
    /\b(cree|creer|creation|fais[ -]moi|fais une|fais un|genere|generer|dessine|redige|rediger|ecris[ -]moi|ecris une|ecris un|page web|site|landing|app|application|appli|jeu|game|logo|icone|icon|image|illustration|photo|dessin|lettre|courrier|cv|rapport|presentation|diagramme|schema|organigramme|flowchart|mockup|maquette|code|script|programme|fonction|html|make me|build|design|draw|write me|write a|mets[ -]le en|mets[ -]la en|change (la|le) (couleur|titre|texte|style)|modifie (la|le)|ajoute (un|une) (bouton|section|page|colonne)|plus (grand|petit|sombre|clair)|en (bleu|rouge|vert|noir|blanc|sombre))\b/,
  widgets:
    /\b(carte|globe|map|zoom\w*|dezoom\w*|rapproche|recentre|centre sur|de plus pres|plus pres|distances?|kilometres?|km|combien de km|place (les|sur)|localise|ou (se trouve|sont)|graphique|graphe|courbe|chart|graph|camembert|histogramme|barres|tableau|table|compare|comparatif|comparaison|evolution|tendance|statistiques?|stats|chiffres?|top \d+|les \d+ (plus|premiers)|classement|ranking|frise|chronologie|timeline|liste des|affiche|montre[ -]moi|visualise|trajet|itineraire|voyage|vols?|flights?|route|par pays|pays|dashboard|tableau de bord|epingle\w*|detache|garde (ce|cet|cette|le|la|les)|ecran du \w+|mon ecran|en direct|live|temps reel|suis (le|la|les)|pib|gdp|population|resultats|scores?|marches|indices|cryptos?)\b/,
  schedule:
    /\b(rappelle[ -]moi|rappels?|remind\w*|programme\w*|planifie\w*|schedule\w*|chaque (jour|matin|soir|semaine|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)|tous les (jours|matins|soirs|lundis|mardis|mercredis|jeudis|vendredis|samedis|dimanches)|every (day|morning|evening|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|en semaine|le week[ -]end|a \d{1,2} ?h|at \d{1,2}(:\d\d)? ?(am|pm)?|demain (a|matin|soir)|tomorrow)\b/,
  personal:
    /\b(mails?|e-mails?|emails?|courriels?|messages? (non lus|recus)|boite (de reception|mail)|inbox|agenda|calendrier|calendar|planning|rendez[ -]vous|rdv|reunions?|meetings?|evenements?|ma journee|my day|point du matin|briefing|programme (du jour|de la journee|de demain)|(suis|serai)[ -]je (libre|dispo)|am i free|qui m a ecrit|who wrote)\b/,
  hud: /\b(panneaux?|panels?|interface|hud|mini fenetre|cache[ -]toi|montre[ -]toi|affiche[ -]toi|mets[ -]toi|deplace[ -]toi|ta fenetre|(deplace|agrandis|reduis|cache|affiche|ferme|mets) (la|le|les) (conversation|graphe|briefing|visuel|panneau|panneaux)|reorganise|dispose|layout)\b/,
};

const SERVICE_WORDS = /\b(mails?|e-mails?|gmail|courriels?|boite de reception|inbox|agenda|calendrier|calendar|rendez[ -]vous|reunions?|meeting|github|notion|drive|slack|maison|lumieres?|lampes?|chauffage|thermostat|volets|home assistant|domotique)\b/;

/** Groups the user's words point to. `extra`: names of installed skills and MCP servers to recognise. */
export function detectGroups(text: string, known: { skills: string[]; services: string[] }): Set<ToolGroup> {
  const t = normalize(text);
  const groups = new Set<ToolGroup>();
  for (const [group, pattern] of Object.entries(INTENTS) as [ToolGroup, RegExp][]) if (pattern.test(t)) groups.add(group);
  const mentions = (names: string[]) => names.some((n) => n.length >= 3 && t.includes(normalize(n).replace(/_/g, ' ')));
  if (/\b(competences?|skills?|automatise|apprends a)\b/.test(t) || mentions(known.skills)) groups.add('skills');
  if (SERVICE_WORDS.test(t) || mentions(known.services)) groups.add('services');
  return groups;
}

/** Approximate tokens of these tools' definitions (name + description + JSON schema), for the cost meter. */
export function definitionTokens(tools: ToolSet, names: string[]): number {
  let chars = 0;
  for (const name of names) {
    const t = tools[name];
    if (!t) continue;
    let schema: unknown = {};
    try {
      const s = t.inputSchema as unknown as { _zod?: unknown; jsonSchema?: unknown };
      schema = s?._zod ? z.toJSONSchema(t.inputSchema as z.ZodType) : (s?.jsonSchema ?? {});
    } catch {
      // unknown schema kind: counted as empty
    }
    chars += name.length + (t.description?.length ?? 0) + JSON.stringify(schema).length;
  }
  return Math.round(chars / 4);
}

/**
 * The groups active for one request, and the load_tools tool that can add more. `recent` holds
 * the groups of the last exchanges (kept for follow-ups).
 */
export function selectTools(
  tools: ToolSet,
  text: string,
  recent: Iterable<ToolGroup>,
  guidanceFor: (toolNames: string[]) => string,
): { active: () => string[]; loadTools: ToolSet; groups: Set<ToolGroup> } {
  const names = Object.keys(tools);
  const available = new Set(names.map(groupOf).filter((g): g is ToolGroup => g !== 'core'));
  const skills = names.filter((n) => n.startsWith('skill_')).map((n) => n.slice(6));
  const services = [...new Set(names.filter((n) => n.startsWith('mcp_')).map((n) => n.split('_')[1]))];
  const groups = new Set([...detectGroups(text, { skills, services }), ...recent].filter((g) => available.has(g)));

  const active = () => [...names.filter((n) => groupOf(n) === 'core' || groups.has(groupOf(n) as ToolGroup)), ...(missing().length ? ['load_tools'] : [])];
  const missing = () => GROUPS.filter((g) => available.has(g) && !groups.has(g));

  const loadTools: ToolSet = missing().length
    ? {
        load_tools: tool({
          description: `Add tool groups you need and do not have yet (they become available at your next step). Available: ${missing()
            .map((g) => `${g} = ${GROUP_INFO[g]}`)
            .join('; ')}.`,
          inputSchema: z.object({ groups: z.array(z.enum(GROUPS as [ToolGroup, ...ToolGroup[]])).describe('Groups to load') }),
          execute: async ({ groups: wanted }) => {
            const added = wanted.filter((g) => available.has(g) && !groups.has(g));
            added.forEach((g) => groups.add(g));
            const loaded = names.filter((n) => added.includes(groupOf(n) as ToolGroup));
            return {
              loaded: added,
              tools: loaded,
              guidance: guidanceFor(loaded) || undefined,
              note: 'These tools are available now: call the one you need.',
            };
          },
        }),
      }
    : {};

  return { active, loadTools, groups };
}
