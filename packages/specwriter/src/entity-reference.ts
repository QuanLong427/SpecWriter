import type { MemoryState } from './types.js';

const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase();
/** Resolve known names to stable IDs without inventing entities or merging ambiguous names. */
export function resolveEntityReference(state: Pick<MemoryState, 'entities'>, label: string, strict = true): string {
  if (state.entities.some(entity => entity.id === label)) return label;
  const owners = state.entities.filter(entity => [entity.name, ...entity.aliases].some(name => normalize(name) === normalize(label)));
  if (owners.length > 1 && strict) throw new Error(`Ambiguous entity reference ${label}; use one of the stable IDs: ${owners.map(entity => entity.id).join(', ')}`);
  return owners.length === 1 ? owners[0]!.id : label;
}
export function entityLabel(state: Pick<MemoryState, 'entities'>, label: string): string {
  return state.entities.find(entity => entity.id === label)?.name ?? label;
}
