import { mesa } from './mesa.js';
import { phoenix } from './phoenix.js';
import { sam } from './sam.js';

/** Adding a city or portal = one adapter file here plus a row in source_config. */
export const ADAPTERS = { [mesa.id]: mesa, [phoenix.id]: phoenix, [sam.id]: sam };
export { mesa, phoenix, sam };
