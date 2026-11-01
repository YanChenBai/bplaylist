import { ref } from 'vue';
import { z } from 'zod';

export const themeSchema = z.enum(['dark', 'light']);

export const theme = ref<'dark' | 'light'>('dark');
