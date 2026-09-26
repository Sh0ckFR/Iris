import { invoke } from '@tauri-apps/api/core';
import { ExternalLinkIcon } from '../icons';

/** "Source" link of an item: opens in the default browser (not in the Iris window). */
export function ItemLink({ url, label }: { url?: string; label?: string }) {
  if (!url) return null;
  const open = () => invoke('os_open_url', { url }).catch((e) => console.warn('[iris] could not open link', url, e));
  let text = label;
  if (!text) {
    try {
      text = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      text = url;
    }
  }
  return (
    <button type="button" className="brief-source" onClick={open} title={url}>
      <ExternalLinkIcon width={13} height={13} />
      {text}
    </button>
  );
}
