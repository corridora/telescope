import type { APIRoute } from 'astro';

import { handleRuns } from '@/lib/agents/controller';

export const prerender = false;
export const ALL: APIRoute = context => handleRuns(context);
