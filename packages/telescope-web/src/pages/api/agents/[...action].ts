import type { APIRoute } from 'astro';

import { handleAgents } from '@/lib/agents/controller';

export const prerender = false;
export const ALL: APIRoute = context => handleAgents(context);
