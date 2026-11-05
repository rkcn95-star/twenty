import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const toSnakeCase = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, 40);

export const pluralize = (singular: string): string =>
  singular.endsWith('y') && !/[aeiou]y$/.test(singular) ? `${singular.slice(0, -1)}ies` : singular.endsWith('s') ? `${singular}es` : `${singular}s`;
